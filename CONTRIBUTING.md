# Contributing to G-Code

Thanks for helping. Issues and pull requests are welcome.

## Contribution terms

G-Code is free for individuals, and Shadow Foundry sells seats to organizations (see [LICENSE](LICENSE) and [COMMERCIAL.md](COMMERCIAL.md)). To keep that possible, every contribution comes with the license in [LICENSE](LICENSE) section 10: by opening a pull request or sending a patch, you grant Shadow Foundry a perpetual, worldwide, royalty-free, irrevocable license to use, change, publish and license your contribution under any terms, including paid commercial licenses, and a license under any of your patent claims it would otherwise infringe.

Send only work you have the right to give: your own, or code under a license that allows it, with its notice kept. If your employer has rights to what you write, get their permission first.

## Before you open a pull request

```bash
bun install
bun run typecheck
HOME=$(mktemp -d) TERM=xterm-256color bun run test
```

`bun run test` runs the whole root and desktop suite and takes several minutes. Do not run bare `bun test` at the root; the Development section of [README.md](README.md) explains why and how to run one file.
