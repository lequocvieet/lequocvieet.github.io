---
title: "Logic Error in Reorg Detection in chain-state update triggers unnecessary reorg handling"
date: 2025-08-13 10:33:00 +0700
categories: [Audits, Citrea]
tags: [rust,citrea,reorg cantina]
description: >-
  Reorg dectection bug in citrea chain-state process — a confirmed Medium finding.
image: /assets/img/citrea.jpg
---

## Metadata

- **Severity:** Medium
- **Status:** Confirmed
- **Likelihood:** High
- **Impact:** Low
- **Created by:** uint256vieet
- **Created at:** August 13, 2025 at 10:33 PM
- **Last updated:** September 24, 2025 at 11:06 PM
- **Reward:** 938.28 $

## Finding Description  
The [`check_chain_state()`](https://cantina.xyz/code/49b9e08d-4f8f-4103-b6e5-f5f43cf9faa1/crates/bitcoin-da/src/monitoring.rs?lines=573,618) does those following things:
1. Only proceeds if the blockchain tip has changed since last check. 
`if new_tip != chain_state.current_tip {`
2. Goes backwards from the new tip, collecting block hashes for the last `finality_depth` blocks.
Go from `i=1` and start with `current_hash` of new block height -1

```rust
         for i in 1..=self.finality_depth {
                //@audit Goes backwards from the new tip, collecting block hashes for the last finality_depth blocks.
                let height = new_height.saturating_sub(i);
                current_hash = self.client.get_block_hash(height).await?;
                new_blocks.push((current_hash, height));
```

3. It checks if any of the new blocks match blocks from the previously stored chain. If a match is found but at a different position, it means the chain reorganized.

```rust
        if let Some(pos) = chain_state
                    .recent_blocks
                    .iter()
                    .position(|&(hash, _)| hash == current_hash) 
                {
                        if pos != i as usize {
                        reorg_detected = true;
                        reorg_depth = i;
                    }
                    break;
```

4. The things here: They compare `pos`(the position found the `hash == current_hash`) so `pos` is an index in the old `recent_blocks` array start with 0 while `i`(the depth from the current new tip start with 1) => These aren't directly comparable 

Ex: Given the following `recent_blocks`:`[100(A), 99(B), 98(C), 97(D)]`
- When a new tip `101(X)` arrives, the loop with `i = 1` => it calculate current hash of `height-1`(101-1) aka `block100(A)` 
- It then compares block `100(A)` against the element at position `0` in the `recent_blocks` list which is `100(A)`. 
- This always matched (Hash mached && `pos`!=`i`: 0!=1 mached)
- => `reorg_detected = true` incorrectly because the check relies on array position rather than depth alignment.
## Impact Explanation
**Medium** 
- Unwarranted reorg handling on each block, inflating work every interval.
- Increased RPC pressure (`get_block_hash`, `get_transaction`, etc.)=> because each reorg handle will `iter` through all monitor transaction  degrading performance.
- Misleading logs/metrics and redundant rebroadcast checks for near-tip transactions.

## Likelihood Explanation
- **High**. Always reorg detected

## Proof of Concept

1. Apply this log for more info:

```rust
if pos != i as usize {
    println!("----------------------------------reorg_detected");
    reorg_detected = true;
    reorg_depth = i;
}
```

2. Start bitcoin regtest and sequencer with the `docs/run-dev.md`

- Build bitcoin binary
- Run bitcoin testnet on docker: `docker compose -f docker/docker-compose.regtest.yml up`
- Setup sequencer wallet and config
- `bitcoin-cli -regtest -rpcuser=citrea -rpcpassword=citrea createwallet citreatesting`
- `bitcoin-cli -regtest -rpcuser=citrea -rpcpassword=citrea loadwallet citreatesting`
- Changes config: [`sequencer_rollup_config.toml`](https://cantina.xyz/code/49b9e08d-4f8f-4103-b6e5-f5f43cf9faa1/resources/configs/bitcoin-regtest/sequencer_rollup_config.toml?lines=7,12)

```toml
[da]
# fill here
node_url = "http://127.0.0.1:18443"
# fill here
node_username = "citrea"
node_password = "citrea"
```

3. Mine some bitcoin blocks for the wallet generated above utxo:

`bitcoin-cli -regtest -rpcuser=citrea -rpcpassword=citrea -generate 201`

4. Edit config for faster check reorg, currently is 60s:

```rust
    pub const fn check_interval() -> u64 {
        1 //change from 60s to 1s
    }
```

5. Start sequencer:

`./target/debug/citrea --dev --da-layer bitcoin --rollup-config-path resources/configs/bitcoin-regtest/sequencer_rollup_config.toml --sequencer resources/configs/bitcoin-regtest/sequencer_config.toml --genesis-paths resources/genesis/bitcoin-regtest/`

- Mine 1 block in bitcoin (1 is enough because always reorg detected):
- `bitcoin-cli -regtest -rpcuser=citrea -rpcpassword=citrea -generate 1`

Sequencer's log:

```bash
2025-08-13T15:11:57.316281Z DEBUG sov_modules_stf_blueprint::stf_blueprint: Beginning l2 block #1842 from sequencer: 0x036360e856310ce5d294e8be33fc807077dc56ac80d95d9cd4ddbd21325eff73f7
2025-08-13T15:11:57.332514Z  INFO citrea_sequencer::runner: New block #1842, Tx count: #0
2025-08-13T15:11:57.332561Z DEBUG citrea_sequencer::runner: New L2 block with hash: "a5fd813c2d14266d9e91a5fffca3ac3fad101c8b460424d67a20d2a38a8ac9c1"
2025-08-13T15:11:57.350581Z DEBUG L1BlockMonitor: bitcoin_da::service: Getting block with hash 423e8587651f134097d028b869e06c2507792788a1b48c93abc0c72edcbaef1e
2025-08-13T15:11:57.351660Z DEBUG L1BlockMonitor: bitcoin_da::service: Getting block at height 333
2025-08-13T15:11:57.352148Z DEBUG L1BlockMonitor: bitcoin_da::service: Getting block with hash 423e8587651f134097d028b869e06c2507792788a1b48c93abc0c72edcbaef1e
2025-08-13T15:11:57.353125Z DEBUG L1BlockMonitor: citrea_sequencer::da: Sequencer: last finalized L1 height: 333
2025-08-13T15:11:57.353153Z DEBUG L1BlockMonitor: bitcoin_da::fee: Fee rate: 1 sat/vb
----------------------------------reorg_detected
2025-08-13T15:11:58.313721Z DEBUG citrea_sequencer::runner: Saving short header proofs to ledger db
2025-08-13T15:11:58.316388Z DEBUG sov_modules_stf_blueprint::stf_blueprint: Beginning l2 block #1843 from sequencer: 0x036360e856310ce5d294e8be33fc807077dc56ac80d95d9cd4ddbd21325eff73f7
2025-08-13T15:11:58.327823Z  INFO citrea_sequencer::runner: New block #1843, Tx count: #0
2025-08-13T15:11:58.327867Z DEBUG citrea_sequencer::runner: New L2 block with hash: "e7f7714373bf7e4485cd1c41ee0b1ee25c4f2e93cf697a5be2f828a3e7f4ea56"
2025-08-13T15:11:59.313062Z DEBUG citrea_sequencer::runner: Saving short header proofs to ledger db
2025-08-13T15:11:59.314485Z DEBUG sov_modules_stf_blueprint::stf_blueprint: Beginning l2 block #1844 from sequencer: 0x036360e856310ce5d294e8be33fc807077dc56ac80d95d9cd4ddbd21325eff73f7
2025-08-13T15:11:59.323723Z  INFO citrea_sequencer::runner: New block #1844, Tx count: #0
```

## Recommendation  
Compare at same depth: Instead of checking position in old array, compare blocks at same depth

```rust

        if let Some(&(stored_hash, stored_height)) = chain_state.recent_blocks.get(i - 1) {
            if current_hash == stored_hash && height == stored_height {
                // Same block at same depth - no reorg
                break;
            } else {
                // Different block at this depth - reorg!
                reorg_detected = true;
                reorg_depth = i;
            }
        }
