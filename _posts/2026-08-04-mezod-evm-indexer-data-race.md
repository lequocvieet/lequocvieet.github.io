---
title: "Data race on latestBlock due to unsynchronized access"
date: 2026-08-04 12:40:00 +0700
categories: [Audits, Mezo]
tags: [golang, data-race, concurrency, mezod, cantina]
---

# Data race on latestBlock due to unsynchronized access

## Metadata

- **Number:** #359
- **Severity:** Medium
- **Status:** Confirmed
- **Likelihood:** High
- **Impact:** Medium
- **Created by:** uint256vieet
- **Created at:** April 29, 2025 at 3:43 PM
- **Last updated:** May 20, 2025 at 6:05 PM
- **Reward:** 1086.10 $

## Description

## Summary

The `latestBlock` variable is accessed and modified concurrently without synchronization, leading to a potential data race.

## Finding Description

In the `OnStart()` function of the `EVMIndexerService` implementation in `server/indexer_service.go`
https://cantina.xyz/code/e757364c-1f68-4ec5-94f6-c6b3c2e80c6d/mezod/server/indexer_service.go?lines=55,125

The variable `latestBlock` is used to track the latest known block height. This variable is shared between two concurrent contexts:

1. A background goroutine that updates `latestBlock` upon receiving new block headers:
    
    ```go
    go func() {
        for {
            msg := <-blockHeadersChan
            eventDataHeader := msg.Data.(types.EventDataNewBlockHeader)
            if eventDataHeader.Header.Height > latestBlock {
                latestBlock = eventDataHeader.Header.Height
                select {
                case newBlockSignal <- struct{}{}:
                default:
                }
            }
        }
    }()
    ```
    
2. The main goroutine that reads the `latestBlock` during the block indexing process:
    
    ```go
    for {
        if latestBlock <= lastBlock {
            select {
            case <-newBlockSignal:
            case <-time.After(NewBlockWaitTimeout):
            }
            continue
        }
        for i := lastBlock + 1; i <= latestBlock; i++ {
            ...
        }
    }
    ```
    

There is no synchronization mechanism (e.g., mutexes or atomic operations) protecting access to `latestBlock`.

This unsynchronized concurrent access creates a data race, which can cause reads or writes to the `latestBlock` to observe stale, partially updated, or corrupted values.

The highest impact scenario is that the indexer may operate on incorrect block heights, skip blocks, reprocess the same blocks, or even crash in extreme cases if memory corruption occurs.

## Impact Explanation

**Medium**.

Data races undermine the fundamental correctness of concurrent programs. In this case, inconsistent values of `latestBlock` can lead to skipped data, incorrect indexing, application crashes, or silent data corruption, severely compromising the service's reliability.

## Likelihood Explanation

**High**.

Since the data race exists on a highly active variable updated as new blocks are received, the conditions for concurrent access are very frequent and almost guaranteed under normal operational load.

## Proof of Concept

I write a unit test in `server/indexer_service_test.go`, no need to care about the un-implemented below comment  `// --- Stub all unused methods ---method` 

I mocked the full interface function to prevent unimplemented errors.
```go
package server_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	abci "github.com/cometbft/cometbft/abci/types"
	"github.com/cometbft/cometbft/libs/bytes"
	"github.com/cometbft/cometbft/libs/log"
	rpcclient "github.com/cometbft/cometbft/rpc/client"
	rpctypes "github.com/cometbft/cometbft/rpc/core/types"
	"github.com/cometbft/cometbft/types"
	tmtypes "github.com/cometbft/cometbft/types"
	"github.com/ethereum/go-ethereum/common"
	"github.com/mezo-org/mezod/server"
	idexTypes "github.com/mezo-org/mezod/types"
)

// MockClient implements the rpcclient.Client interface
type MockClient struct {
	latestBlock int64
	blockCh     chan rpctypes.ResultEvent
}

func (mc *MockClient) Status(ctx context.Context) (*rpctypes.ResultStatus, error) {
	return &rpctypes.ResultStatus{
		SyncInfo: rpctypes.SyncInfo{
			LatestBlockHeight: mc.latestBlock,
		},
	}, nil
}

func (mc *MockClient) Subscribe(ctx context.Context, subscriber, q string, outCapacity ...int) (<-chan rpctypes.ResultEvent, error) {
	return mc.blockCh, nil
}

func (mc *MockClient) Block(ctx context.Context, height *int64) (*rpctypes.ResultBlock, error) {
	return &rpctypes.ResultBlock{
		Block: &types.Block{Header: types.Header{Height: *height}},
	}, nil
}

func (mc *MockClient) BlockResults(ctx context.Context, height *int64) (*rpctypes.ResultBlockResults, error) {
	return &rpctypes.ResultBlockResults{}, nil
}

// MockEVMIndexer is a simple thread-safe mock of EVMTxIndexer
type MockEVMIndexer struct {
	mu            sync.Mutex
	lastBlock     int64
	indexedBlocks map[int64]*tmtypes.Block
}

// NewMockEVMIndexer creates a new mock indexer
func NewMockEVMIndexer() *MockEVMIndexer {
	return &MockEVMIndexer{
		lastBlock:     -1,
		indexedBlocks: make(map[int64]*tmtypes.Block),
	}
}

// LastIndexedBlock returns the last indexed block height
func (m *MockEVMIndexer) LastIndexedBlock() (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lastBlock, nil
}

// IndexBlock mocks indexing a block
func (m *MockEVMIndexer) IndexBlock(block *tmtypes.Block, _ []*abci.ExecTxResult) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if block == nil {
		return errors.New("nil block")
	}
	m.indexedBlocks[block.Height] = block
	m.lastBlock = block.Height
	return nil
}

// TestEVMIndexerService_DataRace simulates the race condition on latestBlock.
func TestEVMIndexerService_DataRace(t *testing.T) {
	// Setup
	mockTxIndexer := NewMockEVMIndexer()
	mockClient := &MockClient{
		latestBlock: 1,
		blockCh:     make(chan rpctypes.ResultEvent, 10000),
	}

	eis := server.NewEVMIndexerService(mockTxIndexer, mockClient)
	// Simulate new blocks rapidly
	mockClient.latestBlock = 10 //Assump current latest block is 10
	for i := int64(2); i < 10000; i++ {
		mockClient.blockCh <- rpctypes.ResultEvent{
			Data: types.EventDataNewBlockHeader{
				Header: types.Header{Height: i},
			},
			// Query: query.Empty{},
		}
	}

	// Run the service in a goroutine
	go func() {
		_ = eis.OnStart() // ignore returned error for now
	}()

	// Let it run for a short while
	time.Sleep(200 * time.Millisecond)
}

// --- other rpcclient.Client methods can panic if called ---

func (mc *MockClient) Unimplemented() {
	panic("unexpected call")
}

// --- Stub all unused methods ---

// GetByTxHash always returns nil in this simple mock
func (m *MockEVMIndexer) GetByTxHash(hash common.Hash) (*idexTypes.TxResult, error) {
	return nil, nil
}

// GetByBlockAndIndex always returns nil in this simple mock
func (m *MockEVMIndexer) GetByBlockAndIndex(blockHeight int64, txIndex int32) (*idexTypes.TxResult, error) {
	return nil, nil
}
func (m *MockClient) Start() error                { return nil }
func (m *MockClient) OnStart() error              { return nil }
func (m *MockClient) Stop() error                 { return nil }
func (m *MockClient) OnStop()                     {}
func (m *MockClient) Reset() error                { return nil }
func (m *MockClient) OnReset() error              { return nil }
func (m *MockClient) IsRunning() bool             { return false }
func (m *MockClient) Quit() <-chan struct{}       { return make(chan struct{}) }
func (m *MockClient) String() string              { return "MockClient" }
func (m *MockClient) SetLogger(logger log.Logger) {}

func (m *MockClient) ABCIInfo(ctx context.Context) (*rpctypes.ResultABCIInfo, error) {
	return nil, nil
}

func (m *MockClient) ABCIQuery(ctx context.Context, path string, data bytes.HexBytes) (*rpctypes.ResultABCIQuery, error) {
	return nil, nil
}

func (m *MockClient) ABCIQueryWithOptions(ctx context.Context, path string, data bytes.HexBytes, opts rpcclient.ABCIQueryOptions) (*rpctypes.ResultABCIQuery, error) {
	return nil, nil
}

func (m *MockClient) BroadcastTxCommit(ctx context.Context, tx tmtypes.Tx) (*rpctypes.ResultBroadcastTxCommit, error) {
	return nil, nil
}

func (m *MockClient) BroadcastTxAsync(ctx context.Context, tx tmtypes.Tx) (*rpctypes.ResultBroadcastTx, error) {
	return nil, nil
}

func (m *MockClient) BroadcastTxSync(ctx context.Context, tx tmtypes.Tx) (*rpctypes.ResultBroadcastTx, error) {
	return nil, nil
}

func (m *MockClient) BlockByHash(ctx context.Context, hash []byte) (*rpctypes.ResultBlock, error) {
	return nil, nil
}

func (m *MockClient) Header(ctx context.Context, height *int64) (*rpctypes.ResultHeader, error) {
	return nil, nil
}

func (m *MockClient) HeaderByHash(ctx context.Context, hash bytes.HexBytes) (*rpctypes.ResultHeader, error) {
	return nil, nil
}

func (m *MockClient) Commit(ctx context.Context, height *int64) (*rpctypes.ResultCommit, error) {
	return nil, nil
}

func (m *MockClient) Validators(ctx context.Context, height *int64, page, perPage *int) (*rpctypes.ResultValidators, error) {
	return nil, nil
}

func (m *MockClient) Tx(ctx context.Context, hash []byte, prove bool) (*rpctypes.ResultTx, error) {
	return nil, nil
}

func (m *MockClient) TxSearch(ctx context.Context, query string, prove bool, page, perPage *int, orderBy string) (*rpctypes.ResultTxSearch, error) {
	return nil, nil
}

func (m *MockClient) BlockSearch(ctx context.Context, query string, page, perPage *int, orderBy string) (*rpctypes.ResultBlockSearch, error) {
	return nil, nil
}

func (m *MockClient) Genesis(ctx context.Context) (*rpctypes.ResultGenesis, error) {
	return nil, nil
}

func (m *MockClient) GenesisChunked(ctx context.Context, chunk uint) (*rpctypes.ResultGenesisChunk, error) {
	return nil, nil
}

func (m *MockClient) BlockchainInfo(ctx context.Context, minHeight, maxHeight int64) (*rpctypes.ResultBlockchainInfo, error) {
	return nil, nil
}

func (m *MockClient) NetInfo(ctx context.Context) (*rpctypes.ResultNetInfo, error) {
	return nil, nil
}

func (m *MockClient) DumpConsensusState(ctx context.Context) (*rpctypes.ResultDumpConsensusState, error) {
	return nil, nil
}

func (m *MockClient) ConsensusState(ctx context.Context) (*rpctypes.ResultConsensusState, error) {
	return nil, nil
}

func (m *MockClient) ConsensusParams(ctx context.Context, height *int64) (*rpctypes.ResultConsensusParams, error) {
	return nil, nil
}

func (m *MockClient) Health(ctx context.Context) (*rpctypes.ResultHealth, error) {
	return nil, nil
}

func (m *MockClient) Unsubscribe(ctx context.Context, subscriber, query string) error {
	return nil
}

func (m *MockClient) UnsubscribeAll(ctx context.Context, subscriber string) error {
	return nil
}

func (m *MockClient) UnconfirmedTxs(ctx context.Context, limit *int) (*rpctypes.ResultUnconfirmedTxs, error) {
	return nil, nil
}

func (m *MockClient) NumUnconfirmedTxs(ctx context.Context) (*rpctypes.ResultUnconfirmedTxs, error) {
	return nil, nil
}

func (m *MockClient) CheckTx(ctx context.Context, tx tmtypes.Tx) (*rpctypes.ResultCheckTx, error) {
	return nil, nil
}

func (m *MockClient) BroadcastEvidence(ctx context.Context, evidence tmtypes.Evidence) (*rpctypes.ResultBroadcastEvidence, error) {
	return nil, nil
}

```
After running the test:

```go
cd server && go test -race -v -run ^TestEVMIndexerService_DataRace$

```

```go
~/Desktop/mezod/server$ go test -race -v -run ^TestEVMIndexerService_DataRace$
=== RUN   TestEVMIndexerService_DataRace
==================
WARNING: DATA RACE
Write at 0x00c00041e008 by goroutine 32:
  github.com/mezo-org/mezod/server.(*EVMIndexerService).OnStart.func1()
      /home/vieet/Desktop/mezod/server/indexer_service.go:82 +0x197

Previous read at 0x00c00041e008 by goroutine 31:
  github.com/mezo-org/mezod/server.(*EVMIndexerService).OnStart()
      /home/vieet/Desktop/mezod/server/indexer_service.go:97 +0x349
  github.com/mezo-org/mezod/server_test.TestEVMIndexerService_DataRace.func1()
      /home/vieet/Desktop/mezod/server/indexer_service_test.go:107 +0x2e

Goroutine 32 (running) created at:
  github.com/mezo-org/mezod/server.(*EVMIndexerService).OnStart()
      /home/vieet/Desktop/mezod/server/indexer_service.go:77 +0x2f2
  github.com/mezo-org/mezod/server_test.TestEVMIndexerService_DataRace.func1()
      /home/vieet/Desktop/mezod/server/indexer_service_test.go:107 +0x2e

Goroutine 31 (running) created at:
  github.com/mezo-org/mezod/server_test.TestEVMIndexerService_DataRace()
      /home/vieet/Desktop/mezod/server/indexer_service_test.go:106 +0x4a4
  testing.tRunner()
      /snap/go/10888/src/testing/testing.go:1792 +0x225
  testing.(*T).Run.gowrap1()
      /snap/go/10888/src/testing/testing.go:1851 +0x44
==================
==================
```

You can see that a data race issue appears when both read and write concurrently.

```go
Write at 0x00c00041e008 by goroutine 32:
  github.com/mezo-org/mezod/server.(*EVMIndexerService).OnStart.func1()
      /home/vieet/Desktop/mezod/server/indexer_service.go:82 +0x197

Previous read at 0x00c00041e008 by goroutine 31:
  github.com/mezo-org/mezod/server.(*EVMIndexerService).OnStart()
      /home/vieet/Desktop/mezod/server/indexer_service.go:97 +0x349
  github.com/mezo-org/mezod/server_test.TestEVMIndexerService_DataRace.func1()
      /home/vieet/Desktop/mezod/server/indexer_service_test.go:107 +0x2e
```

write at :

```go
	go func() {
		for {
			msg := <-blockHeadersChan
			eventDataHeader := msg.Data.(types.EventDataNewBlockHeader)
			if eventDataHeader.Header.Height > latestBlock {
*****				latestBlock = eventDataHeader.Header.Height
				// notify
				select {
				case newBlockSignal <- struct{}{}:
				default:
				}
			}
		}
	}()
```
and read at: 

```go
	if lastBlock == -1 {
*****   lastBlock = latestBlock
	} 
```
## Recommendation

Synchronize access to `latestBlock` to eliminate the data race. There are two common approaches:

1. **Use a `sync.Mutex`** to guard all reads and writes to `latestBlock`.
2. **Use `sync/atomic` package** for atomic reads and writes if performance is critical and `latestBlock` is an integer.


## Comments

---

**Lukasz Zimnoch** - May 19, 2025 at 2:24 PM

This probably needs to be improved but:
- The PoC differs from real time conditions. In reality, blocks do not appear so fast but only every 3.5 seconds which significantly lowers the likelihood.
- This code is used only by RPC nodes so impact is limited to a specific types of nodes

That said, we propose to downgrade the severity to low.

**Replies:**

  ---

  **uint256vieet** - May 20, 2025 at 10:06 AM

  Thanks for the feedback! Let me clarify my reasoning:
  
  1. Block interval doesn’t prevent the race condition:
  Even if blocks arrive every 3.5 seconds (as in Mezo’s case), it doesn’t guarantee that the race condition won’t happen. To illustrate this, I modified the test slightly to simulate block arrivals every 3.5 seconds. As shown below, the race condition still occurs:
  
  ```go
  func TestEVMIndexerService_DataRace(t *testing.T) {
  	mockTxIndexer := NewMockEVMIndexer()
  	mockClient := &MockClient{
  		latestBlock: 1,
  		blockCh:     make(chan rpctypes.ResultEvent, 10000),
  	}
  
  	eis := server.NewEVMIndexerService(mockTxIndexer, mockClient)
  
  	go func() {
  		_ = eis.OnStart()
  	}()
  
  	// Simulate 5 blocks arriving every 3.5 seconds
  	go func() {
  		for i := int64(0); i < 5; i++ {
  			mockClient.blockCh <- rpctypes.ResultEvent{
  				Data: types.EventDataNewBlockHeader{
  					Header: types.Header{Height: i},
  				},
  			}
  			time.Sleep(3500 * time.Millisecond) // Simulate Mezo's block time
  		}
  	}()
  
  	time.Sleep(20 * time.Second)
  }
  ```
  
  The result from the run test race:
  ```shell
  vieet@vieet:~/Desktop/mezod$ cd server && go test -race -v -run ^TestEVMIndexerService_DataRace$
  === RUN   TestEVMIndexerService_DataRace
  ==================
  WARNING: DATA RACE
  Write at 0x00c000aac008 by goroutine 48:
    github.com/mezo-org/mezod/server.(*EVMIndexerService).OnStart.func1()
        /home/vieet/Desktop/mezod/server/indexer_service.go:81 +0x197
  
  Previous read at 0x00c000aac008 by goroutine 46:
    github.com/mezo-org/mezod/server.(*EVMIndexerService).OnStart()
        /home/vieet/Desktop/mezod/server/indexer_service.go:96 +0x351
    github.com/mezo-org/mezod/server_test.TestEVMIndexerService_DataRace.func1()
        /home/vieet/Desktop/mezod/server/indexer_service_test.go:94 +0x2e
  
  Goroutine 48 (running) created at:
    github.com/mezo-org/mezod/server.(*EVMIndexerService).OnStart()
        /home/vieet/Desktop/mezod/server/indexer_service.go:76 +0x2f5
    github.com/mezo-org/mezod/server_test.TestEVMIndexerService_DataRace.func1()
        /home/vieet/Desktop/mezod/server/indexer_service_test.go:94 +0x2e
  ```
  So the timing alone does not eliminate the risk.
  
  2. Exposure is not strictly limited to RPC use-cases:
  While I agree this is commonly used in RPC setups, it can also be enabled through configuration on any node. That means even non-RPC nodes could be affected if they enable the indexer when they index events on their own instead of querying full nodes.
  
  Conclusion:
  Given the persistence of the race condition under realistic timing and the broader exposure due to optional configuration, I believe the issue still qualifies as a valid Medium severity finding.
