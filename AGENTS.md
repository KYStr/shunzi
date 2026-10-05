# 順字

Use Node 24 and TypeScript. This is the MIT public extension and shared core; never copy private hosted code, credentials, private data, or other projects into this repository. Use the agreed plan in docs/PLAN.md. Public release requires the recorded real-user pilot gate; draft/local packages are not a passed pilot.

Acceptance: npm run typecheck, npm test, npm run build, npm run test:browser, npm run release:scan. Real model evaluation must be separately labelled and respect the total NT$300 budget (NT$60 evaluation, NT$210 pilot, NT$30 buffer). Mock tests do not establish model accuracy or latency. Never print or save API keys in test reports.

All persistent Windows environment state is protected. Before/after long build/test/install work run C:/Users/123ik/.codex/check-persistent-environment.ps1 and compare the complete fingerprints. Never change User/Machine environment, PATH, TEMP/TMP, services, BCD or pagefile for development.

Owner boundaries: root owns src/core, build/release/evaluation scripts, integration. Extension agent owns src/extension and its focused tests. Corpus/docs agent owns eval and user documentation. Use only one visual workflow; at most two visual QA rounds.
