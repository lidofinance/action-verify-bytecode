# Verify deployed contracts bytecode action

This action will verify the bytecode of contracts by the definition given in the input file
with the following structure:

```json
[
    {
        "artifactPath": "/path/to/build/dir/with/ContractName.json",
        "sourcePath": "/path/to/src/ContractName.[sol|vy]",
        "name": "ContractName",
        "address": "0x0",
        "txHash": "0x0"
    }
]
```

## Inputs

### `file`

**Required** The path to the file to read definitions from.

### `rpc-url`

RPC endpoint to make requests against. Will fallback to the
provided by the `ethers` package.

## Example usage

### Action

```yaml
uses: lidofinance/action-verify-bytecode@master
with:
    file: artifacts.json
    rpcUrl: http://localhost:8545
```

### Standalone

```bash
INPUT_FILE=artifacts.json [INPUT_RPCURL=http://localhost:8545] node dist/index.js
```
