import * as fs from "fs/promises";

import chalk from "ansi-colors";
import * as core from "@actions/core";
import { ethers } from "ethers";

process.on("unhandledRejection", (reason: any, _) => {
    let error = `Unhandled Rejection occurred. ${reason.stack}`;
    core.setFailed(error);
});

type ArtifactEntry = {
    artifactPath: string;
    sourcePath: string;
    name: string;
    address: string;
    txHash?: string;
};

const greenCheck = chalk.green("✓");
const redCross = chalk.red("×");

(async function main() {
    const registryPath = core.getInput("file");
    const registry: ArtifactEntry[] = JSON.parse(
        await fs.readFile(registryPath, { encoding: "utf8" })
    );

    let provider: ethers.providers.Provider;
    const rpcUrl = core.getInput("rpc-url");
    if (rpcUrl) {
        provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl);
    } else {
        // make it available to use the action without dedicated RPC endpoint
        provider = new ethers.providers.InfuraProvider();
    }

    const promises = registry.map(async (desc: ArtifactEntry) => {
        const isMatched = await verifyBytecode(desc, provider);
        return {
            isMatched,
            desc,
        };
    });
    const results = await Promise.allSettled(promises);

    const sortedFulfilled = results
        .filter((e) => e.status === "fulfilled")
        .sort((a: any, b: any) => -a.value?.isMatched + b.value?.isMatched);

    for (const result of sortedFulfilled) {
        const value = (result as any).value as {
            desc: ArtifactEntry;
            isMatched: boolean;
        };
        const msgParts = value.isMatched ? [greenCheck] : [redCross];
        msgParts.push(" ");
        msgParts.push(value.desc.name);
        msgParts.push(chalk.grey("@"));
        msgParts.push(chalk.blue(value.desc.address));
        const msg = msgParts.join("");

        if (value.isMatched) {
            core.info(msg);
            continue;
        }

        core.setFailed(msg);
    }

    const failures = results.filter((e) => e.status === "rejected");
    for (const fail of failures) {
        core.setFailed((fail as PromiseRejectedResult).reason);
    }
})();

async function verifyBytecode(
    desc: ArtifactEntry,
    provider: ethers.providers.Provider
): Promise<boolean> {
    const artifact = JSON.parse(await fs.readFile(desc.artifactPath, { encoding: "utf8" }));
    const deployedBytecode = await provider.getCode(desc.address);
    const compiledBytecode = artifact.deployedBytecode;
    const language = artifact.language ?? "solidity";

    if (!compiledBytecode || compiledBytecode.length <= 2) {
        throw new Error(`null bytecode read from artifact ${desc.artifactPath}`);
    }

    const status = compareDeployedBytecode(deployedBytecode, compiledBytecode, language);

    // runtime bytecode compare may fail in case of some immutables aren't known at
    // compile time, so fallback to contract creation bytecode check
    if (status === undefined) {
        const tx = await provider.getTransaction(desc.txHash);
        if (!tx) {
            throw new Error(`unable to retrieve transaction ${desc.txHash}`);
        }
        if ((tx as any).creates !== desc.address) {
            throw new Error(`wrong deploy transaction for ${desc.address}`);
        }
        if (!tx.data) {
            throw Error(`no creation bytecode at tx ${desc.txHash}`);
        }
        return compareCreationBytecode(tx.data, artifact.bytecode, language);
    }

    return status;
}

function compareDeployedBytecode(
    blockchainBytecode: string,
    artifactBytecode: string,
    language: string
): boolean {
    // solidity compiler may place links to library contracts which should
    // be replaced by the actual addresses at deployment stage
    if (language === "solidity") {
        // so we basically replace any occurencies of placeholders in compiled bytecode
        // by the parts of the deployed runtime bytecode
        artifactBytecode = replaceSolidityLinks(artifactBytecode, blockchainBytecode);
    }

    if (blockchainBytecode === artifactBytecode) {
        return true;
    }

    if (language === "solidity") {
        // solidity compiler adds some metadata to bytecode tail and it worth to trim it first
        const trimmedDeployed = trimSolidityMeta(blockchainBytecode);
        const trimmedCompiled = trimSolidityMeta(artifactBytecode);

        // no way for bytecode to match if trimmed lengths are differ
        if (trimmedDeployed.length !== trimmedCompiled.length) {
            return false;
        }

        if (trimmedDeployed === trimmedCompiled) {
            return true;
        }
    }

    return undefined;
}

function compareCreationBytecode(
    blockchainBytecode: string,
    artifactBytecode: string,
    language: string
): boolean {
    let compiledBytecode = artifactBytecode;
    if (language === "solidity") {
        // solidity compiler adds some metadata to bytecode tail and it worth to trim it first
        compiledBytecode = trimSolidityMeta(compiledBytecode);
    }

    // The reason why this uses `startsWith` instead of `===` is that
    // creationData may contain constructor arguments at the end part.
    if (blockchainBytecode.startsWith(compiledBytecode)) {
        return true;
    }

    return false;
}

/**
 * Remove metadata from bytecode generated by solidity
 */
function trimSolidityMeta(bytecode: string): string {
    // Last 4 chars of bytecode specify byte size of metadata component.
    const metaSize = parseInt(bytecode.slice(-4), 16) * 2 + 4;
    // When the length of metadata is not appended at the end, it will likely overshoot.
    // There's no metadata to trim.
    if (metaSize > bytecode.length) {
        return bytecode;
    }

    return bytecode.slice(0, bytecode.length - metaSize);
}

/**
 * Replace solidity libraries links by the actual values retrieved from blockchain
 * @see https://docs.soliditylang.org/en/latest/contracts.html#libraries
 */
function replaceSolidityLinks(compiledBytecode: string, deployedBytecode: string): string {
    const PLACEHOLDER_START = "__$";
    const PLACEHOLDER_LENGTH = 40;

    let index = compiledBytecode.indexOf(PLACEHOLDER_START);
    for (; index !== -1; index = compiledBytecode.indexOf(PLACEHOLDER_START)) {
        const placeholder = compiledBytecode.slice(index, index + PLACEHOLDER_LENGTH);
        const address = deployedBytecode.slice(index, index + PLACEHOLDER_LENGTH);
        const regexCompatiblePlaceholder = placeholder
            .replace("__$", "__\\$")
            .replace("$__", "\\$__");
        const regex = RegExp(regexCompatiblePlaceholder, "g");
        compiledBytecode = compiledBytecode.replace(regex, address);
    }

    return compiledBytecode;
}
