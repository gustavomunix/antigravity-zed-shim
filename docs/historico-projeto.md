# Histórico do projeto: Antigravity no Zed Agent

Como colocamos os modelos da assinatura Antigravity (Google) para dentro do
Zed Agent nativo — sem fork do Zed, sem build do editor — e tudo o que foi
avaliado no caminho.

## 1. Objetivo

Usar os modelos da conta Antigravity (Gemini, Claude, GPT-OSS via
assinatura Google, incluindo free tier) **dentro do Zed Agent nativo**:
dropdown de modelos do Agent Panel, Inline Assistant, commit messages.
Em editor Zed instalado normalmente, sem compilar o Zed.

## 2. Repositórios analisados

| Repo | Papel na análise |
|---|---|
| `labs/zed` (source do editor, Rust) | Como providers de LLM são registrados, schema do `settings.json`, o que extensões podem/não podem fazer, como o Zed consome ACP |
| `labs/antigravity-opencode-auth` (plugin opencode, TS) | Como a autenticação OAuth Antigravity funciona e qual é o protocolo real (não documentado pelo Google) |
| `labs/agent-client-protocol` (spec ACP, Rust) | Tipos de auth do protocolo (`agent`, `terminal`, extensões) |
| Docs oficiais via `llms.txt` (`zed.dev`, `agentclientprotocol.com`) | Rotas suportadas: `openai_compatible`, External Agents, ACP Registry |

Técnica de análise: dois subagentes em paralelo (um por repo) + leitura
direta dos arquivos-chave + testes de handshake reais (`agy acp`,
`fetchAvailableModels`, chat completions).

## 3. Matriz de decisão (o que foi avaliado e por quê)

| Caminho | Veredito | Motivo (fonte) |
|---|---|---|
| Só `settings.json` → endpoint Google | Não funciona | Antigravity não é OpenAI-compatível: usa envelope `{project, model, request}` em `v1internal:*` com Bearer curto + User-Agent do Hub (`src/constants.ts:32`, `docs/ANTIGRAVITY_API_SPEC.md`) |
| MCP server | Não serve | No Zed, MCP é só tools/prompts, nunca provider de modelo (`docs/ai/mcp.md`) |
| Extensão Zed (TOML+RS/WASM) | Bloqueado pelo Zed | `crates/extension_cli/src/main.rs:313` rejeita `language_model_providers` ("currently unsupported"); docs listam só languages/themes/debuggers/snippets/MCP |
| ACP oficial (`antigravity-acp` / `agy acp`) | Funciona, mas é thread externa | Dá o agente Google dentro do Zed, porém **não** coloca modelos no Zed Agent |
| Shim local OpenAI-compatível | ✅ Adotado | Rota sancionada (`use-api-access.md#openai-compatible`): processo externo falando HTTP com o Zed |
| Provider nativo em Rust (fork) | Funcional, mas descartado | Implementado e compilado (ver §7); descartado porque exige fork + build do editor, contra o objetivo |

## 4. Como o auth Antigravity funciona (descoberto no plugin)

- OAuth Google com client ID/secret públicos embutidos, PKCE S256, callback
  `http://localhost:51121/oauth-callback` (`src/antigravity/oauth.ts`).
- Credencial salva como `refreshToken|projectId|managedProjectId` em
  `~/.config/opencode/antigravity-accounts.json` (lê `OPENCODE_CONFIG_DIR`,
  migra `%APPDATA%` no Windows).
- Refresh via `oauth2.googleapis.com/token` com dedup; projeto via
  `loadCodeAssist` → `onboardUser` (auto-provisiona), fallback
  `rising-fact-p41fc`.
- Request: `POST daily-cloudcode-pa.googleapis.com/v1internal:{generateContent,streamGenerateContent?alt=sse}`
  com `Authorization: Bearer`, `User-Agent: antigravity/hub/...`.
- Resposta: SSE `data:` com `{response: {candidates: [...], usageMetadata}}`;
  thinking parts (`thought: true`), `functionCall`, `thoughtSignature`.
- Modelos dinâmicos via `fetchAvailableModels` (o catálogo mistura
  experimentos `chat_*`/`tab_*`, filtrados no shim).

## 5. Implementação do shim (`antigravity-zed-shim/`)

Processo Node local que expõe OpenAI-compatível e traduz nos dois sentidos.

- `src/server.ts` — `GET /health`, `GET /v1/models`, `POST /v1/chat/completions` (SSE + JSON).
- `src/translate.ts` — OpenAI messages/tools/`tool_choice`/images-base64 →
  `contents[]`/`systemInstruction`/`functionDeclarations`/`toolConfig`; resposta
  Antigravity → chunks OpenAI (`content`, `reasoning_content`, `tool_calls`,
  `finish_reason`, `usage` com `thoughtsTokenCount` somado).
- `src/accounts.ts` — lê o pool de contas, refresh com cache em memória,
  project context, persiste rotações no arquivo.
- `src/login.ts` — `npm run login` reaproveita o OAuth upstream.
- `src/upstream.ts` — única costura de importação do código vendorizado.
- `vendor/auth-src/` — cópia verbatim do `src/` do plugin (v2.1.2);
  `vendor/PATCHES.md` documenta o único patch (1 linha para o `tsc`).
  `constants.ts` (client ID/secret) é **buscado no postinstall** do commit
  upstream pinado — não vai para o git (GitHub push protection).
- `src/shims/opencode-ai-plugin.d.ts` — tipos ambientes mínimos para o
  `tsc` (o import real é `import type`, apagado em runtime).
- Distribuição: bundle único via esbuild (`dist/cli.js` + `proper-lockfile`
  externo); `npm run serve/models/login/self-test`; `start-windows.cmd`
  para uso no Zed instalado (atalho em `shell:startup` = autostart).

## 6. Incidentes durante a implementação

1. **tsx quebrou no Node 26** (`__name is not a function`, esbuild
   `keepNames`): abandonado loader em runtime; build virou bundle esbuild + `node dist/cli.js`.
2. **Shebang do esbuild na linha 2** → removido (invocamos via `node`).
3. **`proper-lockfile` (CJS com require dinâmico)** quebrava o bundle ESM → marcado como `--external`.
4. **`write after end`** no relay SSE: `finishWithUsage()` e o driver chamavam `res.end()` duas vezes → um `finish()` só.
5. **Usage zerado no stream**: `thoughtsTokenCount` não somado → incluído em `completion_tokens`.
8. **Push rejeitado (GH013)**: client ID OAuth no vendor → `constants.ts` fora do git + fetch pinado no `postinstall`.
7. **Upstream 400 com `max_tokens` gigante**: o Zed repassa a janela de contexto configurada no `settings.json` (1M) como `max_tokens` na requisição; o Google rejeita `maxOutputTokens > 64000` → `src/translate.ts` limita a 64k (`Math.min(maxOutput, 64000)`).
8. **"Connection interrupted" no Zed SSE**: o shim emitia chunk final só para `usage` com `choices: []`; o deserializador Rust do Zed abortava a conexão → `src/server.ts` unificou `finish_reason: "stop"` e `usage` no mesmo chunk oficial.
9. **Proto field not repeating (tools com type array)**: o Zed envia schemas JSON com tipos anuláveis como array (`type: ["string", "null"]`), rejeitado pelo Protobuf do Google → integrado `cleanJSONSchemaForAntigravity` em `src/translate.ts` para achatar tipos e limpar palavras-chave incompatíveis.

## 7. Compatibilidade entre plataformas

O shim é **100% multiplataforma (macOS, Linux, Windows)**:
- **Node.js ≥ 20**: execução idêntica via `dist/cli.js`.
- **Credenciais**: `~/.config/opencode/antigravity-accounts.json` no Mac/Linux (padrão XDG) e `%USERPROFILE%\.config\opencode\` no Windows.
- **Zed `settings.json`**:
  - Mac: `~/Library/Application Support/Zed/settings.json` (ou `~/.config/zed/settings.json`)
  - Linux: `~/.config/zed/settings.json`
  - Windows: `%APPDATA%\Zed\settings.json`
- **Autostart**:
  - Windows: atalho do `start-windows.cmd` em `shell:startup`.
  - Mac/Linux: via `launchd` plist, serviço systemd de usuário ou `pm2`.

## 8. Validação executada

- `tsc --noEmit` limpo; `self-test` offline (tradução ida/volta, envelope, SSE, shapes OpenAI).
- Ao vivo com a conta do usuário: `/health`, `/v1/models` (22 modelos),
  chat non-stream + stream (`finish_reason`/`usage`/`[DONE]`), **tool calling
  completo** (`calc` → `tool_calls`, `finish_reason: tool_calls`).

## 9. ACP oficial (investigação paralela)

- `antigravity-acp` existe no ACP Registry (v1.4.5, binário por plataforma).
- `{"auth": {"type": "oauth-personal"}}` **não existe** em nenhum schema do
  Zed, do Registry ou do protocolo — o servidor local `agy acp` anuncia 4
  métodos `agent`-type (`oauth-personal`, `oauth-business`, `gemini-api-key`,
  `agent-platform`); o Zed suporta login in-thread para esses tipos.
- `agy models` confirmou login ativo e o mesmo catálogo do shim.
- Conclusão: serve para thread externa (zero código, `agy acp` como
  `agent_servers` custom ou via Registry), mas **não** alimenta o Zed Agent.
  Complementar ao shim, não concorrente.

## 10. Provider nativo em Rust (implementado, depois revertido)

Foi implementado `crates/language_models/src/provider/antigravity.rs`
(~1100 linhas): reuso de `into_google` + `GoogleEventMapper`, envelope
`v1internal`, OAuth BYOG do arquivo de contas, catálogo dinâmico,
settings view Inline, 3 testes unitários + wiring completo
(`provider.rs`, `language_models.rs`, `settings.rs`, `settings_content`,
`language_model_core`, `default.json`).

Validação: `cargo check` em `language_model_core`, `settings_content`,
`language_models` (zero warnings), testes 3/3, `settings_ui` + `agent`,
**binário `zed` completo: exit 0**, `cargo test -p settings`: 49/49.
(Exigiu `cmake` via scoop e `CARGO_TARGET_DIR` sem espaços por causa do
`windres` — ambos ambientais.)

**Revertido integralmente** (`labs/zed` limpo): o objetivo era Zed
instalado normalmente, e provider nativo = fork + build do editor.
Mapeamento preservado nesta doc para reaplicação futura.

## 11. Estado final

- Repo publicado: `github.com/gustavomunix/antigravity-zed-shim` (público, MIT).
- `labs/` contém só clones de referência (ignorados).
- Uso: `start-windows.cmd` (ou `npm run serve`) + bloco `openai_compatible`
  no `settings.json` (gerado por `npm run models`) + chave dummy no provider.

## 12. Lições

- O protocolo real só existia no código do plugin comunitário — a doc
  oficial do Google não cobre nada; source-first foi a abordagem correta.
- Reusar o TS upstream verbatim (vendor + seam única) evitou reimplementar
  ~2k linhas instáveis e manteve o diff próprio pequeno (~1k linhas).
- A restrição decisiva do Zed (extensões não provêm modelos) estava no
  validador em Rust, não na documentação — ler o source economizou um
  caminho morto inteiro.
