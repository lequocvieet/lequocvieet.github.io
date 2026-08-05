---
title: "State corruption and block hash mismatch at epoch boundry for Node Joining mid-epoch"
date: 2025-07-09 06:20:00 +0700
categories: [Audits, Citrea]
tags: [rust,telcoin,state corruption cantina]
description: >-
  State corruption and block hash mismatch at epoch boundry for Node Joining mid-epoch of Telcoin network — a confirmed High finding.
image: /assets/img/telcoin.png
---

## Metadata

- **Severity:** High
- **Status:** Duplicate
- **Likelihood:** High
- **Impact:** Medium
- **Created by:** uint256vieet
- **Created at:** July 9, 2025 at 6:20 PM
- **Last updated:** August 22, 2025 at 1:08 AM
- **Reward:** 853.16 $

## Summary
Nodes that join the network **mid-epoch** incorrectly calculate gas usage and consensus rewards due to a logic bug in `catchup_accumulator()`. This causes them to produce a different block at the epoch boundary, resulting in a consensus failure and block hash divergence across nodes => That node stops working normally
## Description  

The [`catchup_accumulator()`](https://cantina.xyz/code/26d5255b-6f68-46cf-be55-81dd565d9d16/telcoin-network/crates/node/src/manager.rs?lines=209,209) function attempts to reconstruct gas usage and leader statistics for nodes that were offline during the current epoch. It uses `reth_env.blocks_for_range()` to retrieve blocks from `epoch_state.epoch_start` to the current block. However, the code mistakenly assumes `epoch_state.epoch_start` is a block number, while in reality it is a **UNIX timestamp (seconds)**.
Because of this, [the call](https://cantina.xyz/code/26d5255b-6f68-46cf-be55-81dd565d9d16/telcoin-network/crates/node/src/manager.rs?lines=112,112):

```rust
let blocks = reth_env.blocks_for_range(epoch_state.epoch_start..=block.number)?;
```

returns an empty block list `(blocks.len() == 0)`. As a result, the [logic inside the loop to accumulate gas and leader data](https://cantina.xyz/code/26d5255b-6f68-46cf-be55-81dd565d9d16/telcoin-network/crates/node/src/manager.rs?lines=114,134) is never executed:

```rust
        for current in blocks { // => never reached
    ...
    gas_accumulator.inc_block(worker_id, gas, limit);
    ...
    gas_accumulator.rewards_counter().inc_leader_count(leader);
}
```

Later, at the epoch boundary, the node calls [`apply_consensus_block_rewards()`](https://cantina.xyz/code/26d5255b-6f68-46cf-be55-81dd565d9d16/telcoin-network/crates/tn-reth/src/evm/block.rs?lines=405,405) inside `builder.finish()` as part of `build_block_from_batch_payload()`. Since the rewards counter is inconsistent with the rest of the network (due to the empty block range earlier), the node generates a different block hash. This causes the block to be rejected by consensus.

Execution flow:

```
spawn_execution_task
  → spawn_blocking_task
    → execute_consensus_output
      → execute_payload()
        → build_block_from_batch_payload()
          → builder.finish()
            → apply_consensus_block_rewards() //❌ divergent data used

```            

```rust
 fn finish(
        mut self,
    ) -> Result<(Self::Evm, BlockExecutionResult<R::Receipt>), BlockExecutionError> {
    ...
            self.apply_consensus_block_rewards(self.ctx.rewards_counter.get_address_counts()) //❌ <== Make block hash divergent
                .map_err(|e| {
                    BlockExecutionError::Internal(InternalBlockExecutionError::Other(e.into()))
                })?;
    ...

    }
```

## Impact Explanation  
**High**. A node that restarts or joins **mid-epoch** ends up with a corrupted `gas_accumulator` state, leading to incorrect reward computations and a divergent block hash at the epoch boundary. This results in **consensus rejection** and that node cannot do anything =>**dead**

## Likelihood Explanation  
**High**. The issue is deterministic and occurs every time a node starts **mid-epoch**. It affects all node types, including validators and observers.

## Proof of Concept 
To reproduce the issue in a test environment:

**1.** Reduce the epoch duration to **200** blocks to allow faster testing because current epoch duration is **1 days**.

**2.** Start 4 nodes and 1 observer node using the provided startup script:

```shell
./etc/local-testnet.sh --dev-funds 0x92D0A7EAf67BC88bA357Fb715BE09299C7347960 --start
```

**3.** Midway through an epoch 0 to epoch 1, shut down and restart the node. In this demo, I will stop the observer (validator is the same):

```shell
#!/bin/bash
# Config
OBSERVER="observer"
DATADIR="./local-validators/$OBSERVER"
INSTANCE=5
METRICS="127.0.0.1:9104"
EXECUTABLE="target/release/telcoin-network"
WAIT_SECONDS=10  # simulate downtime (e.g., mid-epoch)
LOG_FILE="./local-validators/${OBSERVER}.log"

export TN_BLS_PASSPHRASE="local"

# Kill observer process if it's running
echo "[*] Stopping $OBSERVER..."
pkill -f "$EXECUTABLE node --datadir $DATADIR" || echo "No running $OBSERVER found"

echo "[*] Waiting $WAIT_SECONDS seconds (simulate mid-epoch downtime)..."
sleep $WAIT_SECONDS

# Restart observer
echo "[*] Restarting $OBSERVER..."
$EXECUTABLE node --datadir "$DATADIR" \
    --observer \
    --instance "$INSTANCE" \
    --metrics "$METRICS" \
    --log.stdout.format log-fmt \
    -vvv \
    --http > "$LOG_FILE" &

echo "[✓] $OBSERVER restarted."
```

```shell
./start_stop_observer.sh
```

**4.** Allow the node to catch up to the network.

**5.** Observe that at the **epoch boundary**, the restarted node produces a block with a different hash due to divergent `apply_consensus_block_rewards()` results. Apply this diff for more info:

```diff
diff --git a/crates/tn-reth/src/evm/block.rs b/crates/tn-reth/src/evm/block.rs
index 4ee3e570..07c92b17 100644
--- a/crates/tn-reth/src/evm/block.rs
+++ b/crates/tn-reth/src/evm/block.rs
@@ -402,6 +402,10 @@ where
         // potentially close epoch boundary
         if let Some(randomness) = self.ctx.close_epoch {
             debug!(target: "engine", ?randomness, "ctx indicates close epoch");
+            println!(
+                "--------------------------applying consensus block rewards: {:?}",
+                self.ctx.rewards_counter.get_address_counts()
+            );
             self.apply_consensus_block_rewards(self.ctx.rewards_counter.get_address_counts())
                 .map_err(|e| {
                     BlockExecutionError::Internal(InternalBlockExecutionError::Other(e.into()))
```

**6.** At block `209` aka `boundary happens` restarted node produces block with hash: `0xf819c9002065f26580ded9ddac1f2f5a9fbaaf10d29fb3fda026864c36d10fbc`

```shell
--------------------------applying consensus block rewards: {0x1111111111111111111111111111111111111111: 45, 0x2222222222222222222222222222222222222222: 34, 0x3333333333333333333333333333333333333333: 30, 0x4444444444444444444444444444444444444444: 36}
2025-07-09T10:10:39.592779Z  INFO execute: tn::tasks: Epoch Task Manager: latest execution block shutdown successfully
2025-07-09T10:10:39.786268Z  INFO engine: canonical head for epoch 0 round 422: 209 - 0xf819c9002065f26580ded9ddac1f2f5a9fbaaf10d29fb3fda026864c36d10fbc
2025-07-09T10:10:39.786459Z  INFO execute: epoch-manager: epoch boundary success - clearing consensus db tables for next epoch
```

While other nodes produce this hash: `0xfb342daecef545b8938e59988ae64c5f9e5c04a082aa4d61ddb301d8d808ff64`

```shell
2025-07-09T10:10:39.583629Z  INFO primary::certifier: Certificate sender 12D3KooWPa3RK1p1GHRU9FCUSgREWCBaEQpzCJsFopn9BYbunMQs is shutting down!
--------------------------applying consensus block rewards: {0x1111111111111111111111111111111111111111: 66, 0x2222222222222222222222222222222222222222: 45, 0x3333333333333333333333333333333333333333: 48, 0x4444444444444444444444444444444444444444: 50}
2025-07-09T10:10:39.583973Z  INFO execute: tn::tasks: Epoch Task Manager: latest execution block shutdown successfully
2025-07-09T10:10:39.584188Z  WARN primary::network: process_gossip e=Certificate(TNSend("send error: ([], 422)"))
2025-07-09T10:10:39.586485Z  INFO execute: tn::tasks: Epoch Task Manager: ProcessGossip-12D3KooWC58hhs9HuasAfugnBwyqrE2mKBuc8tL9EuVgqoCmS3Ya shutdown successfully
2025-07-09T10:10:39.584455Z  WARN primary::network: process_gossip e=Certificate(TNSend("send error: ([], 422)"))
2025-07-09T10:10:39.587032Z  INFO execute: tn::tasks: Epoch Task Manager: ProcessGossip-12D3KooWPa3RK1p1GHRU9FCUSgREWCBaEQpzCJsFopn9BYbunMQs shutdown successfully
2025-07-09T10:10:39.780666Z  INFO engine: canonical head for epoch 0 round 422: 209 - 0xfb342daecef545b8938e59988ae64c5f9e5c04a082aa4d61ddb301d8d808ff64
```

So the error `Error streaming consensus headers: consensus_output has a parent not in our chain` => The block is rejected by consensus due to mismatch with other nodes => and that node cannot work anymore, whether it is an observer node or a validator node.

```shell
2025-07-09T10:10:39.836039Z  INFO execute: epoch-manager: EPOCH TASKS
 tasks=Epoch Task Manager
Task: latest execution block (critical)
++++++++++++++++++++++++++++++++++++++++++++++++++++
Primary Task Manager
Task: certificate fetcher task (critical)
Task: subscriber follow consensus (critical)

++++++++++++++++++++++++++++++++++++++++++++++++++++
++++++++++++++++++++++++++++++++++++++++++++++++++++
Worker Task Manager - 0
Task: batch-builder (critical)

++++++++++++++++++++++++++++++++++++++++++++++++++++

2025-07-09T10:10:39.836208Z  INFO state-sync: Starting state sync: stream consensus header from peers
2025-07-09T10:10:39.836211Z  INFO state-sync: Starting state sync: track latest consensus header from peers
2025-07-09T10:10:40.895712Z ERROR state-sync: Error streaming consensus headers: consensus_output has a parent not in our chain, missing NumHash { number: 209, hash: 0xfb342daecef545b8938e59988ae64c5f9e5c04a082aa4d61ddb301d8d808ff64 } recents: Ref { inner: RwLockReadGuard(PhantomData<std::sync::poison::rwlock::RwLockReadGuard<tn_primary::recent_blocks::RecentBlocks>>, RecentBlocks { num_blocks: 50, blocks: [SealedHeader { hash: OnceLock(0x0bb2808b9271b58c4bb353e2f1df88ac2ea2f6b5c68c19b56c66ab6d5372bb2b), header: Header { parent_hash: 0x571eb8cd38243a76d8ffff2cd918b270d61ec511b26fef53aa7
```

## Recommendation  
Convert `epoch_state.epoch_start` from timestamp to block number using the existing chain state. This ensures the block range in `blocks_for_range()` is valid and consistent with running nodes.

## Comments

---

**uint256vieet** - July 19, 2025 at 9:11 AM

Thanks, **Haxa**, for the good judging. But I'd like to share my point about the severity:

This issue impacts **all node types** and causes a complete failure to **rejoin the network**, after a restart of both validators and observers. Since it affects **core functionality and network participation**, it should be classified as **High**, not **Medium**. 
