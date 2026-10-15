#!/usr/bin/env node
// Package one platform's built addon as its npm leaf package tarball
// (fork-features/README.md, "Embedded brush shell"):
//
//   node fork-features/native/pack.mjs <platform> <path/to/addon> <tag> <out-dir>
//
// <platform> is `<os>-<cpu>` from upstream omp's native platform set; <tag> is the release tag
// `native-<content hash>`, whose hash becomes the prerelease part of the
// version. The tarball carries the addon, upstream's LICENSE and
// THIRD-PARTY-NOTICES and pi-shell's NOTICE, and has no install scripts.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Upstream omp's native platforms (`packages/natives/scripts/gen-npm-packages.ts`). */
const PLATFORMS = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"]);

const ADDON_FILE = "unified-exec-native.node";

function main([platform, addon, tag, outDir]) {
	if (!PLATFORMS.has(platform) || !addon || !tag?.startsWith("native-") || !outDir) {
		throw new Error("usage: pack.mjs <platform> <addon> <native-<hash> tag> <out-dir>");
	}
	const [os, cpu] = platform.split("-");
	const here = dirname(fileURLToPath(import.meta.url));
	const name = `omp-unified-exec-native-${platform}`;
	const stage = mkdtempSync(join(tmpdir(), `${name}-`));
	copyFileSync(addon, join(stage, ADDON_FILE));
	copyFileSync(join(here, "LICENSE"), join(stage, "LICENSE"));
	copyFileSync(join(here, "THIRD-PARTY-NOTICES.txt"), join(stage, "THIRD-PARTY-NOTICES.txt"));
	copyFileSync(join(here, "crates/pi-shell/NOTICE"), join(stage, "NOTICE"));
	const manifest = {
		name,
		version: `0.0.0-${tag}`,
		description: `omp-unified-exec embedded brush shell addon (${platform})`,
		license: "MIT",
		repository: { type: "git", url: "git+https://github.com/oh-my-omp/omp-unified-exec.git" },
		main: ADDON_FILE,
		files: [ADDON_FILE, "LICENSE", "THIRD-PARTY-NOTICES.txt", "NOTICE"],
		os: [os],
		cpu: [cpu],
	};
	writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	const out = resolve(outDir);
	mkdirSync(out, { recursive: true });
	execFileSync("npm", ["pack", "--pack-destination", out], {
		cwd: stage,
		stdio: ["ignore", "ignore", "inherit"],
		shell: process.platform === "win32",
	});
	// npm names the tarball `<name>-<version>.tgz`; the release asset drops the version.
	const tarball = join(out, `${name}.tgz`);
	renameSync(join(out, `${name}-${manifest.version}.tgz`), tarball);
	console.log(tarball);
}

main(process.argv.slice(2));
