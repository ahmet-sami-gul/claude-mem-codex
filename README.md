# claude-mem-codex

> **Unofficial fork.** claude-mem-codex is an unofficial fork of [claude-mem](https://github.com/thedotmack/claude-mem) by Alex Newman. It is **not affiliated with or endorsed by** the claude-mem project, Anthropic or OpenAI. Please report problems with this fork [here](https://github.com/ahmet-sami-gul/claude-mem-codex/issues), not to the upstream project.

claude-mem is a Claude Code plugin that gives Claude persistent memory: it captures what happens in your sessions, has an "observer" model compress it into observations, and injects the relevant ones into later sessions. This fork adds one thing on top: an observer that runs on your local **Codex CLI**, billed to your **ChatGPT plan's** Codex allowance instead of your Claude plan or an API key.

Everything else (hooks, worker, database, search, viewer) is upstream claude-mem 13.25.2. The upstream README at the fork point is kept in [docs/UPSTREAM_README.md](docs/UPSTREAM_README.md).

## What this fork adds

- **Codex CLI observer provider** (`CLAUDE_MEM_PROVIDER=codex`): observation extraction and session summaries run on the Codex CLI you are already signed in to with ChatGPT.
- **Locked-down, one-shot `codex exec`**: every observer call is one short `codex exec` process with a fixed argument list, no tools, no shell, no user configuration and an allowlisted environment (see [Security model](#security-model)).
- **Lockdown self-check**: five model-free probes (version, login, model catalog, feature list, prompt-input canary) must pass before the first call and again after relevant changes. Nothing is sent to Codex while the check fails.
- **Budget and queue caps**: `CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H` caps observer calls in any sliding 5-hour window, and `CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS` bounds how many tool uses a session may hold while Codex is paused.
- **Same-group batching**: up to 4 tool uses from the same prompt, agent and working directory go out in one call, even when parallel subagents interleave in the queue.
- **Subagent filter**: `CLAUDE_MEM_SUBAGENT_EVENTS=writes` sends only a subagent's file edits to the observer; its reads and searches are still stored raw and searchable, but cost no Codex call.
- **Settings-API hardening**: the worker's unauthenticated settings endpoint can no longer switch the provider to or from Codex, lift the caps, change binaries or logins, or move the data directory. Those are file or environment settings only.
- **GPT-6 models**: `gpt-6-luna`, `gpt-6-sol` and `gpt-6-astra` are available next to the default `gpt-5.6-luna`.
- **Publication changes**: fork-owned marketplace (`claude-mem-codex`), telemetry off by default with no analytics key, upstream CI and release automation removed, and upstream's Cursor, Grok Bot and Cowork plugins not distributed (they run the upstream npm package or stream to cmem.ai). See [CHANGES-FORK.md](CHANGES-FORK.md) for the full list.

## Requirements

- **Claude Code** with plugin support.
- **Bun** 1.1.31 or newer, installed **before** you install the plugin (for example `brew install oven-sh/bun/bun`, or the installer at [bun.sh](https://bun.sh)). Nothing on the plugin-marketplace install path installs it for you; without Bun every hook fails with `Bun not found` and nothing is captured.
- **Node.js** 20.12 or newer.
- **uv** (optional, provides `uvx`): needed for vector search through Chroma (for example `brew install uv`). Without it the worker reports vector search as unavailable.
- **Codex CLI** `>=0.167.0 <0.168` (check with `codex --version`). Other versions are refused by the self-check, see [Limitations](#limitations).
- **A ChatGPT plan that includes Codex** (Plus or higher), signed in with `codex login` using your ChatGPT account. `codex login status` must print `Logged in using ChatGPT`. An API-key login is refused on purpose.
- Tested **only on macOS (Apple silicon, arm64)**. Linux and Windows are untested.

## Install

1. **Remove the official claude-mem first.** Both use the plugin name `claude-mem`, the same hooks and the same data directory (`~/.claude-mem`), so they must not be installed side by side. If you installed it from the upstream marketplace:

   ```bash
   claude plugin uninstall claude-mem@thedotmack
   claude plugin marketplace remove thedotmack
   ```

   Your existing memories in `~/.claude-mem` stay where they are and are used by this fork. Back that directory up before switching.

2. **Add this fork's marketplace and install the plugin:**

   ```bash
   claude plugin marketplace add ahmet-sami-gul/claude-mem-codex
   claude plugin install claude-mem@claude-mem-codex
   ```

3. **Restart Claude Code.** Memory capture starts with the default observer (Claude). The official `npx claude-mem ...` installer is **not** a way to install this fork: that command downloads the official upstream npm package, and this fork does not publish one.

4. **Switch the observer to Codex.** The provider is switched to (and away from) Codex **only** in `~/.claude-mem/settings.json` or the worker's environment, never through the viewer or the settings API. A minimal example:

   ```json
   {
     "CLAUDE_MEM_PROVIDER": "codex",
     "CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H": "200"
   }
   ```

   Write every value as a JSON string (`"200"`, not `200`). No restart is needed: the worker reads the file when it starts the next observer run and runs the self-check first. To check it, open the worker's `/api/health` and look for `ai.provider: "codex"`. Details, every setting and troubleshooting: [docs/public/usage/codex-provider.mdx](docs/public/usage/codex-provider.mdx).

## Key settings

| Setting | Default | Values | What it does |
|---------|---------|--------|--------------|
| `CLAUDE_MEM_PROVIDER` | `claude` | `claude`, `gemini`, `openrouter`, `codex` | `codex` turns on the Codex observer. Switching to or from `codex` is file/env only |
| `CLAUDE_MEM_CODEX_MODEL` | `gpt-5.6-luna` | `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-5.5`, `gpt-6-luna`, `gpt-6-sol`, `gpt-6-astra` | Observer model. The GPT-6 models need codex-cli 0.155 or newer (`gpt-6-astra`: 0.153). `gpt-6-luna` has the largest allowance; keep `gpt-5.6-sol`, `gpt-6-sol` and `gpt-6-astra` off the observer on Plus |
| `CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H` | `0` (no cap) | whole number, `0` or more | Local cap on Codex calls in any sliding 5-hour window. When it is reached, capture pauses until the window frees up. File/env only |
| `CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS` | `500` | `0`, or `50`–`100000` | Most tool uses one session may hold while waiting for Codex; past it the oldest waiting ones are dropped. `0` means no cap. File/env only |
| `CLAUDE_MEM_SUBAGENT_EVENTS` | `all` | `all`, `writes`, `none` | Which subagent tool uses are sent to the observer. `writes` keeps only `Edit`, `Write`, `MultiEdit` and `NotebookEdit`. Main-session tool uses are never affected. File/env only |

On ChatGPT Plus, capturing everything on a busy day does not fit in the 5-hour allowance: set `CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H` (for example `150`–`300`) and consider `CLAUDE_MEM_SUBAGENT_EVENTS=writes` before you turn the provider on. The [Codex provider docs](docs/public/usage/codex-provider.mdx#plan-limits-and-cost) list per-plan guidance.

## Security model

Codex is a coding agent with shell, file and network tools; the observer needs none of them, and everything it reads is untrusted text from your sessions. In short:

- **Closed argument list.** Each call is `codex exec` with `--ignore-user-config`, `--ignore-rules`, `--strict-config`, a read-only sandbox, `--ephemeral`, 67 Codex features disabled and four config pins. Nothing from settings or the API reaches the argument list except the model id (strict pattern), effort, verbosity and the jail directory. There is deliberately no "extra arguments" setting.
- **No tools.** No execution environment (`CODEX_EXEC_SERVER_URL=none`), so no shell, `apply_patch` or image viewing; no MCP servers, web search, plugins or skills.
- **Isolated process.** An allowlisted environment only (API keys and tokens never reach Codex), the login is forced to ChatGPT, the working directory is a per-session jail, and the prompt goes in on stdin.
- **Runtime guard.** The first tool attempt kills the whole process group, discards the reply and writes an entry to `~/.claude-mem/observer-audit.log`; a second attempt stops the provider.
- **Self-check.** Five model-free probes gate every first use and every relevant change.
- **Settings API.** The worker's unauthenticated settings endpoint cannot switch the provider to or from Codex, raise the caps or change the subagent filter, point at another binary or login, or move the data directory.

The full model, including what each probe checks and what is accepted from the model catalog: [docs/public/usage/codex-provider.mdx](docs/public/usage/codex-provider.mdx#the-lockdown).

## Privacy

- **What goes to OpenAI:** with the Codex provider on, every captured tool use (tool name, input, output, working directory, time), your prompts, Claude's last reply in each session (for the summary) and the session-start context built from past observations are sent to OpenAI through your ChatGPT account. They fall under **your ChatGPT data controls**, including whether they may be used for training. Check ChatGPT → Settings → Data controls before turning it on.
- **What is removed first:** only content inside `<private>…</private>` tags (and claude-mem's own injected context). There is no secret scanner: if Claude reads a file with a key in it, the observer receives that key. Use `CLAUDE_MEM_EXCLUDED_PROJECTS` and `CLAUDE_MEM_SKIP_TOOLS` to keep things out.
- **Telemetry is off by default in this fork.** Upstream claude-mem sends anonymous usage analytics by default. This fork ships no analytics key and defaults consent to off, so no analytics or error-tracking request is made unless you set your own `CLAUDE_MEM_TELEMETRY_KEY` **and** explicitly opt in. See [docs/public/telemetry.mdx](docs/public/telemetry.mdx).

## Limitations

- **Codex version pin.** The self-check accepts only codex-cli `>=0.167.0 <0.168`. When Codex updates past that range, capture pauses: observations are held (not sent anywhere else) until you install a tested version, update this fork, or set `"CLAUDE_MEM_CODEX_ALLOW_UNTESTED_VERSION": "true"` (the other probes still run).
- **RAM-only queue.** Observations waiting for Codex (during a pause, a usage limit or a setup problem) live only in the worker's memory. A worker restart discards them, and `CLAUDE_MEM_CODEX_MAX_QUEUED_OBSERVATIONS` drops the oldest ones past the cap.
- **Shared plan allowance.** The observer spends the same 5-hour and weekly Codex limits as your own interactive Codex sessions. Without a cap, a busy day can use up the window and block your own Codex work.
- **Not everything moves to Codex.** Knowledge agents (`build_corpus`, `prime_corpus`, `query_corpus`) still use the Claude Agent SDK and your Claude account. The server runtime has no Codex provider.
- **Upstream documentation.** Apart from the Codex provider and telemetry pages, the files under `docs/public/` and `docs/i18n/` describe upstream claude-mem. `npx claude-mem ...` commands in them run the official npm package, not this fork. The upstream CI workflows are kept but run manually only; the suite is only verified on macOS.

## Terms

Using a ChatGPT plan through Codex CLI for automated background processing may be subject to OpenAI's terms — check them for your account. Use at your own risk.

## License

Apache License 2.0, see [LICENSE](LICENSE). The original work is Copyright 2026 Alex Newman (claude-mem); the modifications in this fork are by Ahmet Sami Gül and are listed in [CHANGES-FORK.md](CHANGES-FORK.md). See [NOTICE](NOTICE). Some upstream subdirectories carry their own terms, for example `cowork/` (PolyForm Noncommercial 1.0.0), which this fork's marketplace does not distribute.

## Credits

- [claude-mem](https://github.com/thedotmack/claude-mem) by Alex Newman: the project this fork is based on, and its [documentation](https://docs.claude-mem.ai).
- [Codex CLI](https://github.com/openai/codex) by OpenAI, which the observer runs on.
- The upstream README at the fork point: [docs/UPSTREAM_README.md](docs/UPSTREAM_README.md).

## Türkçe özet

claude-mem-codex, Alex Newman'ın geliştirdiği claude-mem'in resmî olmayan bir çatalıdır; claude-mem projesi, Anthropic veya OpenAI ile bir bağlantısı yoktur ve onlar tarafından onaylanmamıştır. Çatal, gözlemci (observer) modelini yerel Codex CLI üzerinde, ChatGPT planınızın Codex kotasıyla çalıştıran kilitli bir sağlayıcı ekler. Her çağrı araçsız, sabit argümanlı, tek seferlik bir `codex exec` sürecidir ve ilk çağrıdan önce modelsiz bir öz denetimden geçer. Kurmak için önce resmî claude-mem'i kaldırın, sonra `claude plugin marketplace add ahmet-sami-gul/claude-mem-codex` ve `claude plugin install claude-mem@claude-mem-codex` komutlarını çalıştırıp Claude Code'u yeniden başlatın. Codex'e geçiş yalnızca `~/.claude-mem/settings.json` dosyasındaki `"CLAUDE_MEM_PROVIDER": "codex"` ayarıyla yapılır; Plus planında `CLAUDE_MEM_CODEX_MAX_EXECS_PER_5H` ile bir üst sınır koymanız önerilir. Araç girdileri ve çıktıları ChatGPT hesabınızın veri ayarlarına tabi olarak OpenAI'a gider; bu çatalda telemetri varsayılan olarak kapalıdır. Codex sürümü 0.167.x dışına çıktığında kayıt duraklar, bekleyen gözlemler yalnızca bellekte tutulur ve plan kotası kendi Codex kullanımınızla paylaşılır. Yalnızca macOS arm64 üzerinde test edilmiştir; ChatGPT planını otomatik arka plan işleri için kullanmanın OpenAI koşullarına tabi olabileceğini unutmayın ve riski size ait olmak üzere kullanın.
