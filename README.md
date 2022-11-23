# Verify deployed contracts bytecode action

This action will verify the bytecode of contracts by the definition given in the input file
with the following structure:

```json
[
    {
        "artifactPath": "/path/to/build/dir/with/ContractName.json",
        "jsonPath": "$.optional.json.path.to.artifact.object",
        "sourcePath": "/path/to/src/ContractName.[sol|vy]",
        "name": "ContractName",
        "address": "0x0",
        "txHash": "0x0"
    }
]
```

## Artifacts file preparation

Artifacts file template may be generated by the following scripts:

### Hardhat

```bash
shopt -s globstar
export IGNORE_REGEX="test|lib|mock|interface"
jq 'select(.deployedBytecode? | length > 2) | select(.abi? | length > 0) |
    select(.sourceName? | strings | test(env.IGNORE_REGEX) == false) |
    {artifactPath: input_filename, sourcePath: .sourceName, name: .contractName}' \
    artifacts/contracts/**/*.json | jq -s | tee artifacts.json
```

### Brownie

```bash
shopt -s globstar
export IGNORE_REGEX="test|lib|mock|interface"
jq 'select(.deployedBytecode? | length > 2) | select(.abi? | length > 0) |
    select(.sourcePath? | strings | test(env.IGNORE_REGEX) == false) |
    {artifactPath: input_filename, sourcePath: .sourcePath, name: .contractName}' \
    build/contracts/**/*.json | jq -s | tee artifacts.json
```

### Ape

```bash
shopt -s globstar
MANIFEST=.build/__local__.json
export IGNORE_REGEX="test|lib|mock|interface"
jq '.contractTypes | to_entries | .[] | select(.value.runtimeBytecode?.bytecode
    | length > 2) | select(.value.abi? | length > 0) | select(.value.sourceId? |
    strings | test(env.IGNORE_REGEX) == false) | {artifactPath: input_filename,
    jsonPath: ("$.contractTypes." + .key), sourcePath: .value.sourceId, name:
    .value.contractName}' $MANIFEST | jq -s | tee artifacts.json
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
