import { describe, expect, it } from 'vitest';

import { commandKey, shellKey } from './shell.js';

// Expected keys are the prototype's (session-trace/trace.mjs bashKey and commandKey) for the same commands.

describe('shellKey', () => {
  it.each([
    // cd and other plumbing before the command that does the work
    ['cd /home/dev/shop && pnpm check', 'pnpm check'],
    ['mkdir -p out && rm -rf dist && pnpm build', 'pnpm build'],
    ['export PATH=$PATH:/opt/bin; source env.sh; make', 'make'],
    ['cd web\npnpm lint', 'pnpm lint'],
    ['[[ -d node_modules ]] || pnpm install', 'pnpm install'],
    ['test -f x && echo yes', '(plumbing only)'],
    ['echo done', '(plumbing only)'],
    ['', '(plumbing only)'],
    // for and while loops, if blocks
    ['cd /home/dev/shop && for i in 1 2; do pnpm check | tail -5; done', 'pnpm check'],
    ['for f in *.ts; do echo $f; done', '(plumbing only)'],
    ['while true; do curl -s localhost:3000/health; sleep 1; done', 'curl'],
    ['if [ -f package.json ]; then cat package.json; fi', 'cat'],
    ['make do-thing', 'make'],
    // pipes: only the first command of a pipeline counts
    ['ls -la | grep shop', 'ls'],
    ['cat app.log | grep error || echo none', 'cat'],
    // environment assignments, time, nohup, timeout, subshells and groups
    ['FOO=1 BAR="a b" node scripts/seed.js', 'node'],
    ['time pnpm test', 'pnpm test'],
    ['timeout 60 pnpm test', 'pnpm test'],
    ['nohup node server.js &', 'node'],
    ['(cd web && npm test)', 'npm test)'],
    ['{ echo hi; ls; }', 'ls'],
    ['  sleep 30  ', 'sleep'],
    // $( ) captures are plumbing
    ['out=$(git status --short); echo "$out"', '(plumbing only)'],
    ['rev=$(git rev-parse HEAD) && make build', 'make'],
    ['FOO=$(date) pnpm build', '(plumbing only)'],
    // pnpm --filter, git -C, and other value flags
    ['pnpm --filter @shop/web test', 'pnpm test'],
    ['pnpm -F web lint --fix', 'pnpm lint'],
    ['pnpm --filter', 'pnpm'],
    ['git -C /home/dev/shop log --oneline -5', 'git log'],
    ['git -c core.pager=cat commit -m wip', 'git commit'],
    ['npm --prefix web run test', 'npm run test'],
    ['git', 'git'],
    ['git --version', 'git'],
    ['docker compose up -d', 'docker compose'],
    ['aws s3 ls s3://shop-assets', 'aws s3'],
    ['gh pr view 12 --json title', 'gh pr'],
    ['docker build -t shop .', 'docker build'],
    // npx, and subcommands that run another program
    ['npx vitest run', 'npx vitest'],
    ['pnpm exec tsc -b', 'pnpm exec tsc'],
    ['npm run build', 'npm run build'],
    ['mise run lint', 'mise run lint'],
    ['pnpm run', 'pnpm run'],
    ['pnpm dlx create-vite shop', 'pnpm dlx create-vite'],
    ['yarn x ./node_modules/.bin/eslint .', 'yarn x eslint'],
    // paths are reduced to the program's base name
    ['/usr/bin/python3 -m http.server', 'python3'],
    ['./scripts/deploy.sh --dry-run', 'deploy.sh'],
  ])('%j is %j', (command, key) => {
    expect(shellKey(command)).toBe(key);
  });

  it('treats a missing command as plumbing only', () => {
    expect(shellKey(undefined)).toBe('(plumbing only)');
  });
});

describe('commandKey', () => {
  it.each([
    ['', '(empty)'],
    ['pnpm', 'pnpm'],
    ['pnpm --filter x', 'pnpm'],
    ['git status', 'git status'],
    ['/bin/ls -la', 'ls'],
    ['npx -y tsx run.ts', 'npx tsx'],
    ['npm exec -- tsc', 'npm exec --'],
  ])('%j is %j', (command, key) => {
    expect(commandKey(command)).toBe(key);
  });
});

describe('subcommand tools', () => {
  it('keys only the built-in tools by their subcommand by default', () => {
    expect(shellKey('kubectl get pods')).toBe('kubectl');
    expect(shellKey('git status')).toBe('git status');
  });

  it('keys the tools the options add by their subcommand too', () => {
    const options = { subcommandTools: ['kubectl', 'terraform'] };
    expect(shellKey('kubectl get pods', options)).toBe('kubectl get');
    expect(shellKey('cd infra && terraform -chdir=prod plan | tee plan.txt', options)).toBe('terraform plan');
    expect(commandKey('/usr/local/bin/kubectl exec ./tools/probe', options)).toBe('kubectl exec probe');
    expect(shellKey('git status', options)).toBe('git status');
    expect(shellKey('make test', options)).toBe('make');
  });
});
