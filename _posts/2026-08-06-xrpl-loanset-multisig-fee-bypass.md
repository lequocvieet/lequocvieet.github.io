---
title: "Counterparty Multisig Bypasses Transaction Fee Requirements in LoanSet::calculateBaseFee()"
date: 2025-11-20 22:26:00 +0700
categories: [Audits, XRPL]
tags: [cpp, xrpl, rippled, loan, fee bypass, immunefi, attackathon]
description: >-
  LoanSet::calculateBaseFee() checks the wrong object for counterparty multisigners, allowing fee bypass — a paid Critical finding on Immunefi Attackathon | XRPL Lending Protocol (#60257).
image: /assets/img/xrpl-lending.png
---

> Paid Critical finding on Immunefi Attackathon | XRPL Lending Protocol
{: .prompt-info }

## Metadata

- **Severity:** Critical
- **Status:** Paid
- **Program:** Attackathon | XRPL Lending Protocol
- **Impact:** Modification of the loan setting resulting in unfair distribution and/or gaming of funds
- **Created by:** uint256vieet
- **Created at:** November 20, 2025
- **Confirmed:** December 10, 2025
- **Reward:** 6,611.10 $

## Summary

The `LoanSet::calculateBaseFee()` function incorrectly checks for multisignature signers on the main transaction object instead of the `CounterpartySignature` object.

This allows counterparty accounts using multisignature authorization to completely bypass the additional fee requirements that should be charged for each signer.

An attacker with a counterparty multisig setup could submit `LoanSet` transactions with multiple signers while only paying fees for a single signature.

## Vulnerability Details

The `LoanSet` transaction type supports a special `CounterpartySignature` field that allows a counterparty (typically the borrower in a loan agreement) to co-sign a transaction. According to the inner object format definition in `InnerObjectFormats.cpp`, the `CounterpartySignature` object can contain either a single signature via `sfTxnSignature` or multiple signatures via the `sfSigners` array for multisignature accounts.

Transaction fees in rippled are calculated based on the number of signatures required. The base implementation in `Transactor::calculateBaseFee()` charges one base fee plus an additional base fee for each multisigner. This prevents spam attacks and ensures that transactions consuming more validation resources pay proportionally higher fees.

The `LoanSet::calculateBaseFee()` function attempts to extend this fee calculation to also charge for counterparty signatures. However, it contains a critical logic error:

```cpp
std::size_t const signerCount = tx.isFieldPresent(sfSigners)
    ? tx.getFieldArray(sfSigners).size()
    : (counterSig.isFieldPresent(sfTxnSignature) ? 1 : 0);
```

The code checks `tx.isFieldPresent(sfSigners)` which examines the **main transaction** for multisigners, not the `counterSig` object. This means:

- If the counterparty uses a single signature (`sfTxnSignature` in `CounterpartySignature`), it correctly charges 1 base fee
- If the counterparty uses multisignature (`sfSigners` array in `CounterpartySignature`), it charges **0 fees** because:
  - The condition `tx.isFieldPresent(sfSigners)` evaluates to `false` (main transaction has no signers)
  - The fallback `counterSig.isFieldPresent(sfTxnSignature)` evaluates to `false` (multisig doesn't use single signature field)
  - Result: `signerCount = 0`

The correct implementation can be seen in the `Batch` transaction type, which properly checks the signer object itself:

```cpp
for (STObject const& signer : signers)
{
    if (signer.isFieldPresent(sfTxnSignature))
        signerCount += 1;
    else if (signer.isFieldPresent(sfSigners))
        signerCount += signer.getFieldArray(sfSigners).size();
}
```

The fix should check `counterSig.isFieldPresent(sfSigners)` instead of `tx.isFieldPresent(sfSigners)`:

```cpp
std::size_t const signerCount = counterSig.isFieldPresent(sfSigners)
    ? counterSig.getFieldArray(sfSigners).size()
    : (counterSig.isFieldPresent(sfTxnSignature) ? 1 : 0);
```

## Impact Details

**Critical**: Modification of the loan setting resulting in unfair distribution and/or gaming of funds

This bug modifies the loan setting, resulting in unfair distribution, allowing counterparty multisigners to bypass the intended fee calculation and pay only 1× base fee instead of (1 + N signers)× base fee.

- **Economic Impact**: Counterparty accounts using multisignature can submit `LoanSet` transactions while paying significantly reduced fees. For example, a counterparty with 8 multisigners would only pay the base fee instead of base fee × 8. This represents an 87.5% fee discount that is not available to other network participants.
- **Fairness Violation**: This creates an unfair advantage where counterparty multisig users can perform the same operations as single-sig users at the same cost, despite consuming more network resources for signature verification.

## References

- Vulnerable code: `src/xrpld/app/tx/detail/LoanSet.cpp` — `calculateBaseFee()` lines 162-187
- CounterpartySignature format definition: `src/libxrpl/protocol/InnerObjectFormats.cpp` lines 176-182
- Correct implementation reference: `src/xrpld/app/tx/detail/Batch.cpp` lines 128-134
- Target: [LoanSet.cpp](https://github.com/immunefi-team/attackathon-xrpl-lending-protocol/blob/main/src/xrpld/app/tx/detail/LoanSet.cpp)

## Proof of Concept

Because of the known issue about multi-signing listed in the [Public Disclosure of Known Issues](https://immunefi.com/audit-competition/xrpl-ripple-attackathon/scope/) section (`sign_for error - multi-signing`):

**Conditions**

1. Borrower has multi-signing enabled with two signers.
2. Lender creates LoanSet transaction, populates Counterparty with borrower's account and signs it.
3. Signers individually signs the already signed transaction in #2.
4. CounterpartySignature is populated by sorting two Signer objects based on the Account field as we do for multi-sign transactions.

However, when submitting this transaction, I get: `fails local checks: Counterparty: Invalid signature on account`

So to demonstrate this bug, a unit test is used instead of directly multisigning and submitting the transaction.

### Apply this diff for unit test

{% raw %}
```diff
diff --git a/src/test/app/Loan_test.cpp b/src/test/app/Loan_test.cpp
index c7c601de3d..eb5967200f 100644
--- a/src/test/app/Loan_test.cpp
+++ b/src/test/app/Loan_test.cpp
@@ -2709,6 +2709,80 @@ class Loan_test : public beast::unit_test::suite
         pass();
     }
 
+    void
+    testCounterpartyMultisigFeeBypass()
+    {
+        testcase("Counterparty Multisig Fee Bypass");
+
+        using namespace jtx;
+        using namespace loan;
+
+        Env env(*this, all);
+        Account const lender{"lender"};
+        Account const borrower{"borrower"};
+        Account const signer1{"signer1"};
+        Account const signer2{"signer2"};
+
+        env.fund(XRP(2'000'000), lender, borrower, signer1, signer2);
+
+        env.close();
+
+        // Set up borrower with multisig (2 signers, quorum 2)
+        env(signers(borrower, 2, {{signer1, 1}, {signer2, 1}}));
+        env.close();
+
+        // Create vault and broker using XRP asset
+        PrettyAsset const xrpAsset{xrpIssue(), 1'000'000};
+        BrokerInfo brokerInfo = createVaultAndBroker(env, xrpAsset, lender);
+
+        XRPAmount const baseFee = env.current()->fees().base;
+
+        // Test: Multisig counterparty signature (demonstrates bug)
+        {
+            // Build LoanSet with counterparty multisig
+            auto jtx = env.jt(
+                set(lender, brokerInfo.brokerID, Number(10000)),
+                counterparty(borrower),
+                msig(sfCounterpartySignature, signer1, signer2));
+
+            XRPAmount const fee =
+                LoanSet::calculateBaseFee(*env.current(), *jtx.stx);
+
+            // Expected: normalCost + (2 * baseFee) for 2 counterparty signers
+            XRPAmount const expected = baseFee + (2 * baseFee);  // 3x baseFee
+
+            // BUG: The actual fee will be baseFee (1x) because calculateBaseFee
+            // checks tx.isFieldPresent(sfSigners) instead of
+            // counterSig.isFieldPresent(sfSigners)
+            XRPAmount const buggyActual = baseFee;  // actually returns
+
+            log << "Multisig counterparty (2 signers) fee: " << fee
+                << " (expected: " << expected << ", buggy: " << buggyActual
+                << ")" << std::endl;
+
+            // This assertion will FAIL, demonstrating the bug
+            if (fee == expected)
+            {
+                log << "BUG FIXED: Fee correctly charges for counterparty "
+                       "multisig"
+                    << std::endl;
+            }
+            else if (fee == buggyActual)
+            {
+                log << "BUG CONFIRMED: Counterparty multisig bypasses fee "
+                       "calculation!"
+                    << std::endl;
+                log << "  Fee charged: " << fee << " drops" << std::endl;
+                log << "  Should be:   " << expected << " drops" << std::endl;
+                log << "  Difference:  " << (expected - fee)
+                    << " drops (fee bypass)" << std::endl;
+
+                // Document the bug for the test report
+                BEAST_EXPECT(fee != expected);  // Bug exists
+            }
+        }
+    }
+
 public:
     void
     run() override
@@ -2719,6 +2793,7 @@ public:
         testBatchBypassCounterparty();
         testWrongMaxDebtBehavior();
         testLoanPayComputePeriodicPaymentValidRateInvariant();
+        testCounterpartyMultisigFeeBypass();  // FEE BYPASS BUG TEST
 
         testRPC();
         testBasicMath();
```
{% endraw %}

### Run test after rebuild

```shell
cd .build && ./rippled --unittest=Loan
```

### Test result

```text
ripple.tx.Loan Counterparty Multisig Fee Bypass
Multisig counterparty (2 signers) fee: 10 (expected: 30, buggy: 10)
BUG CONFIRMED: Counterparty multisig bypasses fee calculation!
  Fee charged: 10 drops
  Should be:   30 drops
  Difference:  20 drops (fee bypass)
```

This allows counterparty accounts using multisignature authorization to completely bypass the additional fee requirements that should be charged for each signer => **Fairness Violation**.
