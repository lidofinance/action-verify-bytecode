import * as fs from "fs/promises";

import chalk from "ansi-colors";
import * as core from "@actions/core";
import { ethers } from "ethers";
import { JSONPath } from "jsonpath-plus";

const dmp = require("./lib/dmp.js");

process.on("unhandledRejection", (reason: any, _) => {
    let error = `Unhandled Rejection occurred. ${reason.stack}`;
    core.setFailed(error);
});

type ArtifactEntry = {
    artifactPath: string;
    jsonPath?: string;
    sourcePath: string;
    name: string;
    address: string;
    txHash?: string;
};

const greenCheck = chalk.green("✓");
const redCross = chalk.red("×");

(async function main() {
    const registryPath = core.getInput("file", { required: true });
    const registry: ArtifactEntry[] = JSON.parse(
        await fs.readFile(registryPath, { encoding: "utf8" })
    );

    let provider: ethers.providers.Provider;
    // @see https://github.com/actions/toolkit/issues/629 for explanation why not rpc-url
    const rpcUrl = core.getInput("rpcUrl");
    if (rpcUrl) {
        provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl);
    } else {
        // make it available to use the action without dedicated RPC endpoint
        provider = new ethers.providers.InfuraProvider();
    }

    for (const desc of registry) {
        try {
            const isMatched = await verifyBytecode(desc, provider);
            if (!isMatched) {
                core.setFailed(`Could not verify bytecode of ${desc.name} contract`);
                continue;
            }

            const msgParts = isMatched ? [greenCheck] : [redCross];
            msgParts.push(" ");
            msgParts.push(desc.name);
            msgParts.push(chalk.grey("@"));
            msgParts.push(chalk.blue(desc.address));
            const msg = msgParts.join("");
            core.info(msg);
        } catch (err) {
            core.setFailed(err);
            continue;
        }
    }
})();

async function verifyBytecode(
    desc: ArtifactEntry,
    provider: ethers.providers.Provider
): Promise<boolean> {
    const language = desc.sourcePath.split(".").pop() === "vy" ? "vyper" : "solidity";
    const artifact = await getArtifact(desc);

    const runtimeBytecode = getRuntimeBytecode(artifact);
    if (!runtimeBytecode || runtimeBytecode.length <= 2) {
        throw new Error(`no valid runtime bytecode read for ${desc.name}`);
    }

    const blockchainBytecode = await provider.getCode(desc.address);

    const status = compareDeployedBytecode(blockchainBytecode, runtimeBytecode, language);

    // runtime bytecode compare may fail in case of some immutables aren't known at
    // compile time, so fallback to contract creation bytecode check
    if (!status) {
        if (!desc.txHash) {
            throw new Error(`transaction hash for ${desc.name} is not provided`);
        }

        const deploymentBytecode = getDeploymentBytecode(artifact);
        if (!deploymentBytecode) {
            throw new Error(`no valid deployment bytecode read for ${desc.name}`);
        }

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

        return compareCreationBytecode(tx.data, deploymentBytecode, language);
    }

    return status;
}

async function getArtifact(desc: ArtifactEntry) {
    const artifact = JSON.parse(await fs.readFile(desc.artifactPath, { encoding: "utf8" }));
    if (desc.jsonPath) {
        return JSONPath({
            path: desc.jsonPath,
            json: artifact,
            wrap: false /* to get single value only */,
        });
    }
    return artifact;
}

function getDeploymentBytecode(artifact: any) {
    if (typeof artifact.bytecode === "string") {
        // brownie & hardhat
        return artifact.bytecode;
    } else {
        // ape
        return artifact.deploymentBytecode?.bytecode;
    }
}

function getRuntimeBytecode(artifact: any) {
    if (typeof artifact.deployedBytecode === "string") {
        // brownie & hardhat flavors
        return artifact.deployedBytecode;
    } else {
        // ape
        return artifact.runtimeBytecode?.bytecode;
    }
}

function compareDeployedBytecode(
    blockchainBytecode: string,
    artifactBytecode: string,
    language: string
): boolean {
    blockchainBytecode = trim0x(blockchainBytecode);
    artifactBytecode = trim0x(artifactBytecode);

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

        return trimmedDeployed === trimmedCompiled;
    }

    return false;
}

function compareCreationBytecode(
    blockchainBytecode: string,
    artifactBytecode: string,
    language: string
): boolean {
    blockchainBytecode = trim0x(blockchainBytecode);
    artifactBytecode = trim0x(artifactBytecode);

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

    _print_diff(compiledBytecode, blockchainBytecode);

    return false;
}

/**
 * Trim 0x prefix from the given string
 */
function trim0x(line: string): string {
    if (line.startsWith("0x")) {
        return line.slice(2);
    }

    return line;
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

/**
 * Print git-like diff
 */
function _print_diff(one: string, two: string): void {
    const parts = [];

    const Diff = new dmp.diff_match_patch();
    const diff: [number, string][] = Diff.diff_main(one, two);

    if ("GITHUB_ACTION" in process.env && !core.isDebug() && diff.length > 1_000) {
        core.warning("Large diff detected, turn on debug mode to display");
        return;
    }

    for (const p of diff) {
        let c: chalk.StyleFunction;
        switch (p[0]) {
            case -1:
                c = chalk.red;
                break;
            case 1:
                c = chalk.green;
                break;
            default:
                c = chalk.grey;
        }
        parts.push(c(p[1]));
    }

    core.info(parts.join(""));
}
