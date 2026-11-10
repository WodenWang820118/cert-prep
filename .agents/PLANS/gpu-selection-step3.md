# GPU selection step 3 (issue #258): implementation plan

All `path:line` citations are relative to `C:\software-dev\cert-prep` (`main` at 96d16fd). I read files only: I edited nothing and ran no builds, tests or nx.

Slice 1 (the observed device on `GET /llm/health`) and slice 2 (preference-aware policy in `cert-prep-ollama`) are done. Slice 7 was removed: the product owner declined the coarse `/api/ps` signal on 2026-11-10. Slices 3–6 are unchanged.

Four findings change the shape of the work:
- **The observed device did not reach the API.** The coordinator recorded it, and no route or schema exposed it. Slice 1 returns it as the optional `LLMHealthRead.device`.
- **External Ollama was often missed.** If an outside server was already running when Cert Prep started, ownership stayed `"none"`. Slice 1 calls `note_api_answered()` after a successful `list()`, which marks that server external. `device_status()` also reports a non-local host as external while `ensure_running` still leaves ownership `"none"`.
- **There is no user-settings store.** Settings come only from environment variables, so the device choice needs a new SQLite table (migration 29).
- **The dead-code gate limits how small the slices can be.** It flags any method that only tests call, so each slice must also wire its new code into production use.

## 1. Today's shape

Line numbers in this section, and the `device_policy.py` / `server_coordinator.py` line numbers in section 2, were taken before slice 2. Slice 2 moved the policy builders and the owned-server start path. Auto still follows the branches below. What slice 2 changed is in section 5.

**Inventory**
- Every adapter carries `classification`, PCI vendor and device ids, `adapter_luid` and an internal `pnp_device_id` (`packages/cert-prep-contracts/src/cert_prep_contracts/hardware.py:44-58`).
- `device_id` is not "the NVIDIA UUID, otherwise the PnP id". nvidia-smi writes the UUID (`inventory.py:228`). Win32_VideoController writes the PnP instance id into both `device_id` and `pnp_device_id` (`inventory.py:264-265`). Native DXGI writes neither (`_native_gpu_inventory.py:81-94`): only PCI ids and a LUID. Merge keeps `device_id` by legacy precedence and keeps `pnp_device_id` if any source had it (`inventory.py:607-611`). A native-only adapter therefore has no PnP id and no UUID, so its adapter key is the `pci:` fallback.
- The LUID is the DXGI adapter LUID, which Windows assigns per boot. `_native_gpu_inventory.py:139-142` only formats it; it does not document that.
- Rows without native DXGI evidence become `unknown` (`inventory.py:620-624`).
- Backend inventory is cached for 300 s (`machine_inventory.py:13`). The check is in `collect_ollama_machine_inventory` (`:37-41`); `OllamaMachineInventory.inventory` is `:25-26`.

**Policy and child environment** (`select_ollama_device_policy`, `device_policy.py:152-275`)
- Non-Windows or no inventory → unmanaged (`:161-166`).
- Dedicated GPU: NVIDIA → CUDA pinned by UUID; AMD → ROCm; other vendors → Vulkan (`:182-227`).
- No dedicated GPU but an unknown one → unmanaged (`:230-235`).
- iGPU only → Vulkan with `OLLAMA_IGPU_ENABLE=1` (`:238-258`).
- Otherwise → CPU masks (`:260-275`).
- `ollama_child_environment` applies the policy, case-insensitively on Windows; unmanaged passes the environment through unchanged (`:286-325`).
- `corrected_device_policy` builds the single correction from the devices Ollama discovered (`:328-419`).

**Coordinator** (`server_coordinator.py`)
- `ensure_running` marks the server external only when the API answers and we own no live process (`:245-249`), or after a port race (`:288-291`).
- For a non-local host it only probes and leaves ownership `"none"` (`:242-243`).
- The policy is chosen at spawn and reused after a correction (`:263-270`).
- `after_model_load` → `_verify_latest_load` (`:320-423`):
  - A server we don't own gives state `unknown` (`:326-349`).
  - Missing logs give `unknown` and verification stays pending (`:357-375`).
  - A mismatch triggers exactly one corrective restart (`:387-411`); with no derivable correction there is no restart (`:412-419`).
- `_restart_server` waits at most 30 s for running calls, then proceeds anyway (`:430-435`).
- Verification states are `verified | mismatch | selected_unverified | unknown` (`device_verification.py:23`). The `DeviceExecution` record is at `:27-43`.
- An unmanaged policy with no log and no discovered device still returns `unknown` and null observed fields. When any evidence exists, slice 1 keeps the observed library, description, PCI bus and layer counts and still reports `unknown`. Before slice 1 the layer counts were already kept; library, description and PCI were cleared. The plan's earlier sentence that unmanaged "drops all observed fields" was wrong on both counts.
- `DeviceExecution.observed_at` defaults to `time.time` (wall clock, `device_verification.py:43`). The coordinator's clock argument defaults to `time.monotonic` (`server_coordinator.py:90`) and is what stored records use. Neither value is exposed.

**How far the observed device travels**
- It is stored on `coordinator._device_execution`. Slice 1 removed `device_execution()` from the coordinator, the transport and the lazy provider. Only a wiring test had called that path.
- Health reads `device_status()` (`server_coordinator.py`), one locked snapshot from `cert_prep_ollama.device_status.build_device_status`. That snapshot has no `observed_at` and no English `detail`.
- `OllamaProvider._device_for_health` maps the snapshot to `OllamaDeviceStatus` (`ai_providers/domain/device.py`). `GET /llm/health` returns it as `LLMHealthRead.device`.

**What the API exposes now**
- `GET /llm/health` (`ai_providers/api/router.py`) returns `LLMHealthRead`, built from `ProviderHealth`. It still reports `execution_mode` and `execution_warning`, and for Ollama also the optional `device` object from section 3. A provider that is not Ollama, including the fake provider, leaves `device` null.
- `execution_mode` is still fixed when the provider is created (`cert_prep_ollama/profiles.py`). CPU mode still sends `num_gpu=0` with every request. Slice 1 does not change generation or model loading.

**External Ollama**
- `health()` still calls `ensure_running` only when `list()` fails. Generation never calls `ensure_running`.
- `ensure_running` still marks the server external only when the API answers and this process owns no live process, or after a port race. A non-local host only probes and leaves ownership `"none"`.
- After a successful `list()`, health calls `note_api_answered()`. That sets ownership to `"external"` when this process does not own a live server (a tray app, or a non-local host whose API answered). It does not demote a live owned process.
- `device_status()` reports a non-local host as `external` even while ownership is still `"none"`.

**Wiring and settings**
- One coordinator is built per app (`bootstrap/app.py:206-212`; `ai_providers/infrastructure/ollama_server.py:10-19`). The desktop host passes no GPU variables (`apps/cert-prep-desktop/src-tauri/src/backend_process.rs:136-147`).
- Settings are environment-only (`platform/config.py:21-22`). Persistent data is SQLite with append-only migrations (`platform/database.py:14-17`); the last migration is 28 (`:732`).
- The generated TypeScript client must match OpenAPI byte for byte (`tests/unit/test_openapi_client_generator.py:257-262`; target at `apps/cert-prep-backend/project.json:63-72`).
- Enums defined in a context's `domain` must map to vocabulary concepts (`tests/unit/test_ubiquitous_language.py:85-105`, decision D12 at `.agents/PLANS/ddd-refactor/decisions.md:28`). Domain classes must be in the glossary (`test_ubiquitous_language.py:56-70`). Use cases must match `docs/domain/ai_providers.md` (`tests/unit/test_use_cases.py:10`).

## 2. Part 1: device override

**Data model.** `DevicePreference(mode: auto|cpu|adapter, adapter_key: str|None)`.
- `adapter_key` is opaque: the first 16 hex characters of sha256 over the first available of `pnp:<PnP instance id>`, `nvidia:<GPU UUID>`, `pci:<ven>:<dev>:<normalized name>`. Never the LUID, which changes every boot.
- PnP ids and UUIDs survive reboots and driver updates. A PnP id changes when a card moves slot.
- The row also stores `adapter_name`, `pci_vendor_id` and `pci_device_id` as a fallback: if the key no longer matches, it re-matches when exactly one current adapter has the same vendor and device id. This covers slot moves and nvidia-smi disappearing.
- If two adapters share a key, they are not selectable.
- Hashing keeps the internal `pnp_device_id` (`hardware.py:57`) out of the API.

**When the chosen adapter is missing** (or no longer classified): fall back to Auto, keep the stored choice, and report status `adapter_missing`. The choice applies again when the adapter returns.

**Persistence.**
- Migration 29 adds a single-row table: `ollama_device_preference` with `id CHECK(id=1)`, `mode CHECK IN ('auto','cpu','adapter')`, `adapter_key`, `adapter_name`, `pci_vendor_id`, `pci_device_id`, `updated_at`. No row means Auto.
- The store is `ai_providers/infrastructure/device_preference_repository.py`, behind a port in `application/ports.py`.
- The table belongs to `ai_providers`: add it to the D17 table-ownership list (`decisions.md:33`).
- Older binaries ignore the extra migration row, because `migrate()` only applies missing versions (`database.py:775-809`).

**Matrix.** The policy function gains `preference=`. The branch code is refactored into per-adapter builders.

| Override \ machine | NVIDIA dGPU (± iGPU) | AMD dGPU | other dGPU | iGPU only | unknown class | no GPU / software | non-Windows |
|---|---|---|---|---|---|---|---|
| Auto | as today: CUDA by UUID | ROCm | Vulkan | Vulkan + IGPU_ENABLE=1 | unmanaged | CPU masks | unmanaged |
| CPU | CPU masks | CPU masks | CPU masks | CPU masks | CPU masks (managed) | CPU masks | unmanaged (`not_applicable`) |
| Adapter = dGPU | its vendor branch, pinned | ROCm | Vulkan | n/a | its branch | n/a | n/a |
| Adapter = iGPU | Vulkan + IGPU_ENABLE=1, CUDA and HIP hidden | same | same | same as Auto | same | n/a | n/a |
| Adapter missing | Auto + `adapter_missing` | ← | ← | ← | ← | ← | ← |

- With an iGPU chosen on a mixed machine, Vulkan may still pick the dGPU. The existing single correction then pins `GGML_VK_VISIBLE_DEVICES` (`device_policy.py:388-395`).
- Choices offered: GPUs with classification `dedicated` or `integrated` only. Adapters classified `unknown` are listed but cannot be chosen (decision 3, 2026-11-10). Slice 2 enforces that in the policy; the list itself is slice 3.

**When it takes effect.** Add `OllamaServerCoordinator.apply_device_preference()`:
- Clear `_policy`, `_restarts` and `_device_execution`; each new choice gets its own one corrective restart.
- If we own the server and it is idle (`_admissions_paused_when_idle`, `server_coordinator.py:195-208` before slice 2): stop it and start it with the new policy now. A lazy start is not enough. `generate_structured_json` and `_json_chat` (`ollama_transport.py:191-244`) do not call `ensure_running`. The old citation `:248-257` is `pull_model`, which also does not start the server.
- If a generation is running: set a pending flag. Never interrupt the call and never reuse the 30 s deadline. The switch happens at the next idle `after_model_load` (skipping verification of the old load) or the next `ensure_running`.
- External server: save only. Not running: applies at the next start.
- The coordinator reads `preference_provider()` (a constructor argument; slice 3 wires it from the store in `ollama_server.py`) on every owned start, including a corrective restart. Slice 2 does that read inside `_owned_policy`.

**CPU in the existing health fields.** When the owned policy target is `cpu`, the provider asks the coordinator per call:
- `execution_mode=cpu`, with a warning that names the user's choice.
- `num_gpu=0` in requests (`_chat_options`, `ollama_transport.py:187-188`).
- The existing "CPU" label then appears with no new UI (`apps/cert-prep/src/app/runtime/data/model-health-view-model.service.ts:60-64`).

**API.**
- `GET /llm/device-preference` returns:
  - `mode`
  - `adapter_key | null`
  - `adapter_name | null`
  - `status`: `active | pending | external_server | adapter_missing | not_applicable`
  - `choices`: a list of `{adapter_key, name, classification, backend}`
- `PUT /llm/device-preference` takes `{mode, adapter_key?}`.
- Validation returns 422 when:
  - `mode=adapter` has no key, or a key that is not among the current choices (code `unknown_device`);
  - `auto` or `cpu` comes with a key.
- New use cases: `show_device_preference` and `choose_device_preference`.

## 3. Part 2: observed device in the status

Add `LLMHealthRead.device: OllamaDeviceRead | null` (optional, so the change is additive).

`OllamaDeviceRead` fields:
- `server`: `OllamaServerOwnership` = `owned | external | not_running`
- `requested`: `{target: DeviceTarget (dedicated_gpu|integrated_gpu|cpu|unmanaged), backend: DeviceBackend (cuda|rocm|vulkan|cpu) | null, adapter_name: str|null} | null`
- `verification`: `DeviceVerification` = `pending | verified | mismatch | unknown | not_observable`
- `observed`: `{backend: DeviceBackend|null (normalized from "CUDA0" and similar), adapter_name: str|null, offloaded_layers: int|null, total_layers: int|null} | null`
- `corrective_restarts`: int (0 or 1)

`observed_at` and the English `detail` stay internal. The enums are StrEnums in a new `ai_providers/domain/device.py`, so the vocabulary and glossary gates cover them.

| Situation | server | requested | verification | observed | restarts |
|---|---|---|---|---|---|
| Provider not Ollama (fake) | `device = null` | | | | |
| Not installed / not running | not_running | null | not_observable | null | 0 |
| Owned, before first load, logs missing, or scheduler choice only | owned | policy | pending | null | 0 |
| Owned, verified (partial offload counts) | owned | policy | verified | runner | 0/1 |
| Mismatch → restarted, before reload | owned | corrected policy | pending | null | 1 |
| Second mismatch (no CPU fallback) | owned | corrected | mismatch | actual device in use | 1 |
| Mismatch, no correction derivable | owned | policy | mismatch | actual | 0 |
| CPU (override or no GPU) | owned | cpu/cpu | verified | cpu, 0/N layers | 0 |
| Unmanaged (unknown class, non-Windows) | owned | unmanaged | unknown | from logs (new) | 0 |
| External (tray app or non-local host) | external | null | not_observable | null | 0 |
| Right after a preference change (slice 4, not slice 1) | owned | new policy | pending | null | 0 |

`corrected_device_policy` keeps the same `target`, `backend` and `adapter_name`. It changes the child environment, PCI bus and reason. After a corrective restart the API `requested` object therefore does not show a different name. The restart is `corrective_restarts: 1` with `verification: pending` until the new server loads, then `mismatch` if the second load still disagrees. There is no CPU fallback on that second mismatch.

**Implementation.**
- Add a locked `coordinator.device_status()` snapshot built from `_policy`, `_verification_pending`, `_restarts` and `_device_execution`. The raw fields are inconsistent right after a restart (`server_coordinator.py:408-411`).
- Add `note_api_answered()`. It marks the server external when the coordinator is open and this process does not own a live server: a tray app, a non-local host, or an owned process that has already exited while the API still answers. Health calls it only after a successful `list()`. `device_status()` reports a non-local host as external even before that call, while `ensure_running` still leaves ownership `"none"`.
- Populate observed fields for unmanaged policies (`device_verification.py:119-140`). Lines 80-95 only unpack the load records.

**Consumers that must change.**
- `ProviderHealth`, `LLMHealthRead`, and `OllamaProvider._health_metadata_fields`.
- Delete the now-unused `device_execution` path: `ollama_transport.py:86-88`, `provider.py:65`, the coordinator's `:473-475`, and the test `test_ollama_coordinator_wiring.py:250-259`.
- Regenerate `libs/cert-prep-api/src/lib/cert-prep-api.generated.ts`.
- Add vocabulary concepts (`packages/cert-prep-contracts/vocabulary/cert-prep-vocabulary-v1.json`), glossary rows (`.agents/PLANS/ddd-refactor/glossary.md` §AI 供應, line 101), the 用語 table in `docs/domain/ai_providers.md`, and `.agents/SPECS/domains/parsing-reasoning.md:17-22`.
- A frontend type change is optional: the e2e mock's `satisfies LLMHealthRead` (`apps/cert-prep-e2e/src/e2e/support/mock-api.ts:396-404`) still compiles.

**Compatibility.** No stored data changes. Older clients ignore the optional field. A contract test should check:
- `device` is optional and nullable;
- an old payload still validates;
- every enum value maps to a vocabulary concept.

Model it on `tests/unit/test_gpu_inventory_contract.py:22-65`.

## 4. Part 3: external Ollama guidance

**Detection.**
- Today the server is marked external only inside `ensure_running` (`server_coordinator.py:245-249,288-291`).
- That misses the common case, a tray app running before Cert Prep starts (see section 1). Slice 1 fixes it.
- A non-local `OLLAMA_HOST` is always external.

**What the app can honestly say.**
- It cannot read an external server's log, so it cannot know which adapter or backend is used: `verification=not_observable`.
- Ollama's `/api/ps` reports `size_vram` against `size`, which would give a coarse GPU-share or CPU signal but no adapter. The product owner declined that signal on 2026-11-10. It is not a slice.
- The stored choice is saved but not applied (`status=external_server`).
- To let Cert Prep start its own server: quit the tray Ollama, then press "Refresh all" (`runtime-manager.page.html:116-124`). Health then fails `list()`, `ensure_running` starts our own server with the stored choice, and ownership becomes owned.

**Where it appears.** The runtime manager page (`/runtime`), in a new "Device" section after the Reasoning model row (`apps/cert-prep/src/app/runtime/feature/runtime-manager/runtime-manager.page.html:83-106`). The view model is built in `model-health-view-model.service.ts` style.

**Wording for the product owner to decide** (each a suggestion only):
- Section title: 「運算裝置」
- Options: 「自動（建議）」, 「只用 CPU（較慢）」, and for an adapter: name + 「獨立／內建顯示卡」
- Verified: 「正在使用：{name}」
- Mismatch: 「預定 {requested}，實際使用 {observed}」
- Pending: 「載入模型後確認」
- Switch waiting for a running generation: 「目前的產生完成後切換」
- Adapter missing: 「找不到選擇的顯示卡，暫用自動選擇」
- External meaning: 「Ollama 已在別處執行（例如系統匣），Cert Prep 不會更改它，也無法得知它用哪個裝置」
- External action: 「若要由 Cert Prep 選擇裝置，請從系統匣結束 Ollama，再按「全部重新整理」」
- Saved while external: 「已儲存；Cert Prep 自行啟動 Ollama 時套用」

**Screen choices for the product owner to decide:**
- **Language.** The runtime manager is English today (`runtime-manager.page.html:3`; `model-health-view-model.service.ts:40-70`). Newer copy is zh-TW constants (`apps/cert-prep/src/app/runtime/domain/runtime-update-copy.constants.ts:1-25`). There is no i18n framework, so new zh-TW copy makes the page mixed-language.
- **Placement.** A new section, or inside the Ollama row.
- **Control.** Radio group or select.
- **Technical detail.** Whether to show CUDA, Vulkan or ROCm and layer counts.
- **External guidance.** Persistent or dismissible; whether it also shows as a toolbar chip.

## 5. Slices (each runs `pnpm ci:local portable` before merge)

`pnpm ci:local portable` covers: lint with import-linter through `lint-architecture` (`apps/cert-prep-backend/project.json:37-44`), tests, type-check, the dead-code gate `--ci`, architecture tests, check and exceptions, the generated-client test, the Angular build and mocked e2e on chromium (`tools/run-local-ci.mts:46-147`). Run `pnpm run architecture:update` whenever modules or edges change.

1. **Observed device in `/llm/health`.** Status: done in this change. No screen change; merge on green.
   - Depends on nothing.
   - Changes:
     - `device_verification.py` (observed fields for unmanaged)
     - `server_coordinator.py` (`device_status`, `note_api_answered`)
     - new `ai_providers/domain/device.py`
     - `domain/provider.py`, `infrastructure/ollama_transport.py`, `infrastructure/provider.py`, `api/schemas.py`
     - generated client, vocabulary, glossary, docs
   - Tests:
     - coordinator status in every row of the section 3 table, using the existing fakes (`packages/cert-prep-ollama/tests/test_server_coordinator.py:22-78`) and log fixtures
     - integration `/llm/health` for owned/verified, external pre-started, fake → null (`tests/integration/test_ollama_provider.py`)
     - contract test

2. **Preference-aware policy in the package.** Status: done in this change. No screen change.
   - Depends on nothing.
   - Changes: `device_policy.py` (`OllamaDevicePreference`, `adapter_key`, per-adapter builders, `preference=`); `server_coordinator.py` (`preference_provider`, default Auto, so behavior is unchanged until a later slice wires a store).
   - The returned policy's `application` is `applied`, `adapter_missing`, or `not_applicable`. A missing or no-longer selectable adapter falls back to Auto and keeps `adapter_missing`. Non-Windows or no inventory stays unmanaged and reports `not_applicable`.
   - Every owned start, including the corrective restart, reads `preference_provider()`. A corrected policy is reused only while that read still matches the preference the correction was built for.
   - Tests:
     - parametrized matrix (section 2 table) in `test_device_policy.py`
     - key stable across LUID changes and loss of the nvidia-smi row; identical adapters ambiguous
     - each start reads the preference; a corrected policy is reused only within one preference

3. **Store and `GET /llm/device-preference`.** No screen change.
   - Depends on 1 and 2.
   - Changes:
     - `platform/database.py` (migration 29)
     - new repository with `load` only
     - `ollama_server.py` and `bootstrap/app.py` wiring
     - `selectable_adapters`
     - use case `show_device_preference`, router and schemas
     - D17 note, docs, client
   - Tests: migration test (`tests/integration/test_database_migrations.py`), GET with no row → Auto, choice list from fixture inventories.

4. **`PUT` and apply.** No screen change, but a CPU choice made through the API alone changes the existing CPU label; that path is not reachable from the UI.
   - Depends on 3.
   - Changes: repository `save`; `choose_device_preference`; router; `apply_device_preference` with the pending switch; dynamic CPU `execution_mode` and `num_gpu`.
   - Tests:
     - idle switch restarts once with the new environment
     - a switch during a running call waits, then applies after it
     - external server saved but not applied
     - 422 cases
     - choice survives an app restart (new `create_app`)

5. **Device status and external guidance on `/runtime`.** Screen change: needs product-owner review.
   - Depends on 1.
   - Changes: `runtime/domain/device-*.contracts.ts` plus copy constants, a view-model service, a `runtime/ui` component, the page html; extend `MockCertPrepApiOptions` (`mock-api.ts:78`).
   - Tests: vitest view-model spec per table row; component spec; mocked e2e for verified, mismatch and external guidance, alongside `mocked-journeys.spec.ts:562-572`.

6. **Device chooser.** Screen change: needs product-owner review.
   - Depends on 4 and 5.
   - Changes: `runtime-api-clients.service.ts`; a new `device-preference.store.ts`; the UI component.
   - Tests: store spec (PUT, then reload health and preference); e2e chooses CPU and asserts the PUT body and the CPU status.
   - Fetch the preference only on `/runtime`, or the full-journey `seenPaths` equality fails (`mocked-journeys.spec.ts:59`; `mock-api.ts:1020-1040`).

Slice 7 (coarse `/api/ps` GPU/CPU signal for an external server) was declined on 2026-11-10 and is not part of this plan.

Slices 1–4 can be merged on green checks. Slices 5–6 need the product owner's review of the screen. The wording and layout of those two screens are chosen at implementation time from the suggestions in section 4; the screens are still shown to the product owner.

## 6. Risks and open questions

**Risks**
- **Wasted model load on mixed machines.** Choosing the iGPU on a mixed machine costs one load before the correction pins Vulkan.
- **A deferred switch may wait a long time** when streaming workers stay busy. It still applies at the next idle health check.
- **A new Ollama version can change its log format.** Status then shows `unknown`, which stays honest.
- **The existing 30 s corrective-restart deadline** can still cut off a running call (`server_coordinator.py:430-435`). The override does not reuse it. Fixing it is out of scope.
- **The dead-code gate forbids test-only methods,** so slices 3 and 4 cannot shrink further.

**Decisions by the product owner (2026-11-10)**
1. When the chosen adapter is missing: fall back to Auto, keep the stored choice, and report `adapter_missing`. The choice applies again when the adapter returns.
2. CPU choice with an external Ollama: still send `num_gpu=0` on each request. That does not reconfigure the server. CPU execution mode already does this in `_chat_options` (`ollama_transport.py:187-188`; the old citation `:172-173` was wrong).
3. Adapters classified `unknown` are listed but cannot be chosen.
4. The coarse `/api/ps` signal for external servers is not in scope. Slice 7 is removed.
5. The new `ollama_device_preference` table under `ai_providers` is approved (an addition to D17).
6. A device switch never cancels a running generation. It waits.
7. Wording and layout of the two screen slices are decided at implementation time from the suggestions in section 4. The screens are still shown to the product owner.

### Critical Files for Implementation
- C:\software-dev\cert-prep\packages\cert-prep-ollama\src\cert_prep_ollama\server_coordinator.py
- C:\software-dev\cert-prep\packages\cert-prep-ollama\src\cert_prep_ollama\device_policy.py
- C:\software-dev\cert-prep\apps\cert-prep-backend\src\cert_prep_backend\ai_providers\infrastructure\ollama_transport.py
- C:\software-dev\cert-prep\apps\cert-prep-backend\src\cert_prep_backend\ai_providers\api\schemas.py
- C:\software-dev\cert-prep\apps\cert-prep\src\app\runtime\data\model-health-view-model.service.ts
