import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getLatestRunwayBuildUrl } from './runway'

const STATE_FILE = path.join(os.homedir(), '.metamask-designer-tools.json')
const REPO_DIR = path.join(os.homedir(), 'metamask-mobile')
const RUNWAY_BUCKET = 'https://app.runway.team/bucket/aCddXOkg1p_nDryri-FMyvkC9KRqQeVT_12sf6Nw0u6iGygGo6BlNzjD6bOt-zma260EzAxdpXmlp2GQphp3TN1s6AJE4i6d_9V0Tv5h4pHISU49dFk='

type Emit = (event: string, data: unknown) => void

interface State {
  infuraKey?: string
  installedBuild?: string
  setupComplete?: boolean
  githubToken?: string
  githubUsername?: string
  currentBranch?: string
  claudeKey?: string
}

// Async exec that streams stdout/stderr lines to the log
function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))))
    proc.on('error', reject)
  })
}

function runWithLog(
  cmd: string,
  args: string[],
  log: (msg: string) => void,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const onLine = (chunk: Buffer) => {
      chunk.toString().split('\n').filter(Boolean).forEach(line => log(line))
    }
    proc.stdout?.on('data', onLine)
    proc.stderr?.on('data', onLine)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))))
    proc.on('error', reject)
  })
}

function runShell(cmd: string, log: (msg: string) => void, cwd?: string, env?: NodeJS.ProcessEnv): Promise<void> {
  return runWithLog('/bin/bash', ['-c', cmd], log, { cwd, env })
}

function whichInEnv(bin: string, env: NodeJS.ProcessEnv): boolean {
  try {
    require('child_process').execSync(`which ${bin}`, { stdio: 'ignore', env })
    return true
  } catch { return false }
}

/** Build a full PATH string covering all common tool locations.
 *  Electron apps launch with a very minimal PATH — this ensures brew,
 *  node, corepack, yarn, git, watchman etc. are all findable. */
function buildFullPath(): string {
  const home = os.homedir()
  const extras = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    `${home}/.nvm/versions/node/v20/bin`,
    `${home}/.volta/bin`,
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]
  return [...extras, process.env.PATH || ''].join(':')
}

export class SetupRunner {
  private emit: Emit
  private state: State = {}
  // Full PATH built once at construction — all steps use this so tools are always findable
  private env: NodeJS.ProcessEnv = { ...process.env, PATH: buildFullPath() }

  constructor(emit: Emit) {
    this.emit = emit
    this.loadState()
  }

  private loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        this.state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
      }
    } catch { this.state = {} }
  }

  private saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2))
  }

  private log(msg: string) { this.emit('setup:log', msg) }

  private progress(step: string, status: 'running' | 'done' | 'skipped' | 'error', detail?: string) {
    this.emit('setup:progress', { step, status, detail })
  }

  getState(): State { return this.state }

  async runStep(stepId: string, payload?: Record<string, string>): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    try {
      switch (stepId) {
        case 'check-xcode':          return await this.checkXcode()
        case 'install-prereqs':      return await this.installPrereqs()
        case 'save-infura-key':      return this.saveInfuraKey(payload?.key ?? '')
        case 'clone-repo':           return await this.cloneOrPullRepo()
        case 'install-deps':         return await this.installDeps()
        case 'download-build':       return await this.downloadBuild()
        case 'check-refine-ai':      return await this.checkRefineAi()
        case 'launch':               return await this.launch()
        // ── PR steps ──
        case 'save-github-token':       return await this.saveGithubToken(payload?.token ?? '')
        case 'save-claude-key':         return this.saveClaudeKey(payload?.key ?? '')
        case 'check-cursor':            return await this.checkCursor()
        case 'open-cursor':             return await this.openCursor(payload?.file)
        case 'pr-sync':                 return await this.prSync()
        case 'pr-create-branch':        return await this.prCreateBranch(payload?.name ?? '')
        case 'pr-changed-files':        return await this.prChangedFiles()
        case 'pr-update-snapshots':     return await this.prUpdateSnapshots()
        case 'pr-commit-push':          return await this.prCommitPush(payload?.message ?? '', payload?.prBody)
        case 'check-branch-guard':      return await this.checkBranchGuard()
        case 'pr-update-branch':        return await this.prUpdateBranch()
        case 'get-refine-annotations':  return await this.getRefineAnnotations()
        case 'generate-commit-message': return await this.generateCommitMessage(payload?.annotations ?? '')
        default: return { ok: false, error: `Unknown step: ${stepId}` }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.emit('setup:error', msg)
      return { ok: false, error: msg }
    }
  }

  private async checkXcode(): Promise<{ ok: boolean; error?: string }> {
    this.progress('prereqs', 'running', 'Checking Xcode...')
    try {
      require('child_process').execSync('xcode-select -p', { stdio: 'ignore' })
      if (!fs.existsSync('/Applications/Xcode.app')) throw new Error()
      this.progress('prereqs', 'running', 'Homebrew, Node 20, Yarn, Watchman')
      return { ok: true }
    } catch {
      this.progress('prereqs', 'error', 'Xcode not found')
      return { ok: false, error: 'xcode-missing' }
    }
  }

  private async installPrereqs(): Promise<{ ok: boolean; error?: string }> {
    this.progress('prereqs', 'running')
    const log = this.log.bind(this)

    const env = this.env

    // ── Homebrew ──
    // Detect by absolute path, NOT via which() — avoids PATH issues
    const brewBin = fs.existsSync('/opt/homebrew/bin/brew')
      ? '/opt/homebrew/bin/brew'
      : fs.existsSync('/usr/local/bin/brew')
      ? '/usr/local/bin/brew'
      : null

    if (!brewBin) {
      log('Installing Homebrew (this takes a few minutes)...')
      await runShell(
        'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        log, undefined, env
      )
    } else {
      log(`Homebrew already installed ✓`)
    }

    const brew = brewBin ?? (fs.existsSync('/opt/homebrew/bin/brew') ? '/opt/homebrew/bin/brew' : '/usr/local/bin/brew')

    // ── Node 20 ──
    const nodeVersion = (() => {
      try {
        return require('child_process').execSync('node --version', { encoding: 'utf8', env }).trim()
      } catch { return '' }
    })()

    if (!nodeVersion.startsWith('v20')) {
      log(`Installing Node 20 (current: ${nodeVersion || 'none'})...`)
      await runWithLog(brew, ['install', 'node@20'], log, { env })
      await runWithLog(brew, ['link', 'node@20', '--force', '--overwrite'], log, { env })
    } else {
      log(`Node 20 already installed (${nodeVersion}) ✓`)
    }

    // ── Yarn via corepack ──
    if (!whichInEnv('yarn', env)) {
      log('Enabling Yarn via corepack...')
      // Use full path to corepack in case it's not on the shell PATH yet
      const corepackBin = (() => {
        try {
          return require('child_process').execSync('which corepack', { encoding: 'utf8', env }).trim()
        } catch { return 'corepack' }
      })()
      await runShell(`${corepackBin} enable && ${corepackBin} prepare yarn@4 --activate`, log, undefined, env)
    } else {
      log('Yarn already installed ✓')
    }

    // ── Watchman ──
    if (!whichInEnv('watchman', env)) {
      log('Installing Watchman...')
      await runWithLog(brew, ['install', 'watchman'], log, { env })
    } else {
      log('Watchman already installed ✓')
    }

    // ── Git ──
    if (!whichInEnv('git', env)) {
      log('Installing Git...')
      await runWithLog(brew, ['install', 'git'], log, { env })
    } else {
      log('Git already installed ✓')
    }

    this.progress('prereqs', 'done')
    return { ok: true }
  }

  private saveInfuraKey(key: string): { ok: boolean; error?: string } {
    if (!key || key.trim().length < 10) return { ok: false, error: 'Invalid API key' }
    this.state.infuraKey = key.trim()
    this.saveState()
    return { ok: true }
  }

  private async cloneOrPullRepo(): Promise<{ ok: boolean; error?: string }> {
    this.progress('repo', 'running')
    const log = this.log.bind(this)

    if (fs.existsSync(path.join(REPO_DIR, '.git'))) {
      log('Pulling latest metamask-mobile...')
      await runWithLog('git', ['pull'], log, { cwd: REPO_DIR, env: this.env })
    } else {
      log('Cloning MetaMask/metamask-mobile (this may take a minute)...')
      await runWithLog('git', [
        'clone', '--depth=1',
        'https://github.com/MetaMask/metamask-mobile.git',
        REPO_DIR,
      ], log, { env: this.env })
    }

    // Write .js.env — use .js.env.example as base so all required vars are present
    const envPath = path.join(REPO_DIR, '.js.env')
    const examplePath = path.join(REPO_DIR, '.js.env.example')
    if (!fs.existsSync(envPath)) {
      if (fs.existsSync(examplePath)) {
        let template = fs.readFileSync(examplePath, 'utf8')
        template = template.replace(
          /export MM_INFURA_PROJECT_ID=.*/,
          `export MM_INFURA_PROJECT_ID="${this.state.infuraKey}"`
        )
        fs.writeFileSync(envPath, template)
        log('Created .js.env from template with your Infura key ✓')
      } else {
        fs.writeFileSync(envPath, [
          `export MM_INFURA_PROJECT_ID="${this.state.infuraKey}"`,
          'export METAMASK_ENVIRONMENT="dev"',
          'export METAMASK_BUILD_TYPE="main"',
        ].join('\n') + '\n')
        log('Created .js.env with your Infura key ✓')
      }
    } else {
      // Ensure critical build vars are present even in existing files
      let content = fs.readFileSync(envPath, 'utf8')
      let updated = false
      if (!content.includes('METAMASK_BUILD_TYPE')) {
        content += '\nexport METAMASK_BUILD_TYPE="main"\n'
        updated = true
      }
      if (!content.includes('METAMASK_ENVIRONMENT')) {
        content += '\nexport METAMASK_ENVIRONMENT="dev"\n'
        updated = true
      }
      if (updated) {
        fs.writeFileSync(envPath, content)
        log('.js.env updated with required build vars ✓')
      } else {
        log('.js.env already exists — leaving untouched ✓')
      }
    }

    this.progress('repo', 'done')
    return { ok: true }
  }

  private async installDeps(): Promise<{ ok: boolean; error?: string }> {
    this.progress('deps', 'running')
    const log = this.log.bind(this)

    // Skip only if node_modules AND Yarn's state file both exist (Yarn Berry requirement)
    const modulesExist = fs.existsSync(path.join(REPO_DIR, 'node_modules'))
    const yarnStateExists = fs.existsSync(path.join(REPO_DIR, '.yarn', 'install-state.gz'))
    if (modulesExist && yarnStateExists) {
      log('Dependencies already installed — skipping ✓')
      this.progress('deps', 'skipped')
      return { ok: true }
    }

    log('Running yarn install...')
    await runWithLog('yarn', ['install'], log, { cwd: REPO_DIR, env: this.env })

    log('Running yarn setup:expo — this takes 5-10 minutes...')
    await runWithLog('yarn', ['setup:expo'], log, { cwd: REPO_DIR, env: this.env })

    this.progress('deps', 'done')
    return { ok: true }
  }

  private async downloadBuild(): Promise<{ ok: boolean; error?: string }> {
    this.progress('build', 'running')
    const log = this.log.bind(this)

    log('Checking latest Runway build...')
    const result = await getLatestRunwayBuildUrl(RUNWAY_BUCKET, log)

    if (!result.url || !result.filename) {
      return { ok: false, error: 'Could not find a build with an .app.zip on Runway' }
    }

    const buildId = result.filename.replace('.app.zip', '')

    if (this.state.installedBuild === buildId) {
      log(`Build ${buildId} already installed ✓`)
      this.progress('build', 'skipped', buildId)
      return { ok: true }
    }

    const zipPath = path.join(os.tmpdir(), result.filename)

    // If the zip already exists from a previous run, ask the designer whether to reuse it
    let skipDownload = false
    if (fs.existsSync(zipPath)) {
      const stat = fs.statSync(zipPath)
      const ageMins = Math.round((Date.now() - stat.mtimeMs) / 60000)
      const { dialog, BrowserWindow } = require('electron')
      const win = BrowserWindow.getAllWindows()[0]
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Use existing download', 'Download fresh'],
        defaultId: 0,
        title: 'Build already downloaded',
        message: `A build was already downloaded ${ageMins < 60 ? `${ageMins} min` : `${Math.round(ageMins / 60)}h`} ago.`,
        detail: `Use the existing file to save time, or download the latest from Runway.`,
      })
      skipDownload = response === 0
      if (skipDownload) log(`Reusing existing download (${ageMins} min old) ✓`)
    }

    if (!skipDownload) {
      log(`Downloading ${result.filename}...`)
      await runWithLog('curl', ['-L', '--progress-bar', '-o', zipPath, result.url], log, { env: this.env })
    }

    const appDir = path.join(os.tmpdir(), 'metamask-sim-app')
    fs.rmSync(appDir, { recursive: true, force: true })
    fs.mkdirSync(appDir, { recursive: true })

    log('Unzipping...')
    await runWithLog('unzip', ['-o', zipPath, '-d', appDir], log, { env: this.env })

    log('Booting Simulator...')
    await runShell('xcrun simctl boot "iPhone 16" 2>/dev/null || xcrun simctl boot "iPhone 15" 2>/dev/null || true', log, undefined, this.env)

    // Find the .app bundle — handle both nested (.app folder inside zip) and
    // flat (zip extracted .app contents directly into appDir) zip structures
    let appPath: string | undefined = require('child_process')
      .execSync(`find "${appDir}" -name "*.app" -maxdepth 3`, { encoding: 'utf8', env: this.env })
      .split('\n').filter(Boolean)[0]

    if (!appPath && fs.existsSync(path.join(appDir, 'Info.plist'))) {
      // The zip extracted the .app bundle contents flat — rename appDir to MetaMask.app
      const renamedPath = path.join(os.tmpdir(), 'MetaMask.app')
      if (fs.existsSync(renamedPath)) fs.rmSync(renamedPath, { recursive: true, force: true })
      fs.renameSync(appDir, renamedPath)
      appPath = renamedPath
      log('Detected flat .app bundle structure ✓')
    }

    if (!appPath) throw new Error('Could not find .app bundle in downloaded zip')

    log(`Installing ${path.basename(appPath)} into Simulator...`)
    await runWithLog('xcrun', ['simctl', 'install', 'booted', appPath], log, { env: this.env })

    this.state.installedBuild = buildId
    this.saveState()

    this.progress('build', 'done', buildId)
    return { ok: true }
  }

  private async launch(): Promise<{ ok: boolean; error?: string }> {
    this.progress('launch', 'running')
    const log = this.log.bind(this)

    // ── Step 1: Boot simulator ──
    log('Opening Simulator...')
    await run('open', ['-a', 'Simulator'])
    await new Promise(r => setTimeout(r, 3000))

    // ── Step 2: Start bundler FIRST, logging to a file so we can debug ──
    const bundlerLog = path.join(os.tmpdir(), 'metamask-bundler.log')
    log(`Starting Metro bundler (log: ${bundlerLog})...`)
    const logFd = require('fs').openSync(bundlerLog, 'w')
    const bundler = spawn('yarn', ['watch:clean'], {
      cwd: REPO_DIR,
      env: { ...this.env, METAMASK_ENVIRONMENT: 'dev', METAMASK_BUILD_TYPE: 'main' },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
    bundler.unref()

    // ── Step 3: Wait for Metro to be ready on port 8081 (max 3 min) ──
    const bundlerReady = await new Promise<boolean>((resolve) => {
      const start = Date.now()
      const maxWait = 180000
      let elapsed = 0
      const poll = () => {
        elapsed = Math.round((Date.now() - start) / 1000)
        try {
          require('child_process').execSync(
            'curl -sf http://localhost:8081/status > /dev/null',
            { env: this.env, stdio: 'ignore' }
          )
          resolve(true)
        } catch {
          // Show last line of bundler log so user can see what's happening
          try {
            const lastLine = require('child_process')
              .execSync(`tail -1 "${bundlerLog}"`, { encoding: 'utf8', env: this.env })
              .trim()
            if (lastLine) log(`Bundler (${elapsed}s): ${lastLine}`)
            else log(`Waiting for bundler... ${elapsed}s`)
          } catch { log(`Waiting for bundler... ${elapsed}s`) }

          if (Date.now() - start < maxWait) {
            setTimeout(poll, 5000)
          } else {
            resolve(false)
          }
        }
      }
      setTimeout(poll, 8000)
    })

    if (bundlerReady) {
      log('Bundler is ready ✓')
    } else {
      log('Bundler taking longer than expected — continuing anyway')
    }

    // ── Step 4: Now launch MetaMask (bundler is ready) ──
    log('Launching MetaMask in Simulator...')
    // Use Expo dev client deep link — connects directly to bundler, no "Fetch development servers" needed
    const bundlerUrl = encodeURIComponent('http://localhost:8081')
    await runShell(
      `xcrun simctl openurl booted "metamask://expo-development-client/?url=${bundlerUrl}" 2>/dev/null || xcrun simctl launch booted io.metamask.MetaMask 2>/dev/null || true`,
      log, undefined, this.env
    )

    // ── Step 5: Launch Refine AI ──
    // Small delay so macOS finishes processing the MetaMask deep link first
    await new Promise(r => setTimeout(r, 2000))
    log('Launching Refine AI...')
    await runShell(
      'open -a "Refine AI" && sleep 1 && osascript -e \'tell application "Refine AI" to activate\' 2>/dev/null || true',
      log, undefined, this.env
    )

    this.state.setupComplete = true
    this.saveState()

    this.progress('launch', 'done')
    return { ok: true }
  }

  private async checkRefineAi(): Promise<{ ok: boolean; error?: string }> {
    this.progress('refine-ai', 'running', 'Checking Refine AI...')
    const log = this.log.bind(this)
    const https = require('https')
    const REFINE_AI_APP = '/Applications/Refine AI.app'
    const RELEASES_API = 'https://api.github.com/repos/jasonculbertson/refine-ai-releases/releases/latest'

    // Fetch latest release info from GitHub
    const latestRelease = await new Promise<{ tag_name: string; assets: { name: string; browser_download_url: string }[] } | null>((resolve) => {
      https.get(RELEASES_API, { headers: { 'User-Agent': 'metamask-designer-setup' } }, (res: any) => {
        let data = ''
        res.on('data', (chunk: any) => data += chunk)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve(null) }
        })
      }).on('error', () => resolve(null))
    })

    if (!latestRelease || !latestRelease.tag_name) {
      log('No Refine AI release found on GitHub yet — skipping')
      this.progress('refine-ai', 'skipped')
      return { ok: true }
    }

    const latestVersion = latestRelease.tag_name.replace(/^v/, '') // e.g. "1.1.1"
    const pkgAsset = latestRelease.assets.find((a: any) => a.name.endsWith('.pkg'))

    // Check currently installed version
    const installedPlistPath = `${REFINE_AI_APP}/Contents/Info.plist`
    const installedVersion = (() => {
      try {
        const out = require('child_process').execSync(
          `defaults read "${installedPlistPath}" CFBundleShortVersionString`,
          { encoding: 'utf8', env: this.env }
        ).trim()
        return out
      } catch { return null }
    })()

    if (installedVersion === latestVersion) {
      log(`Refine AI ${latestVersion} already up to date ✓`)
      this.progress('refine-ai', 'done', `v${latestVersion} ✓`)
      return { ok: true }
    }

    if (!pkgAsset) {
      log('No .pkg found in latest Refine AI release — skipping')
      this.progress('refine-ai', 'skipped')
      return { ok: true }
    }

    if (installedVersion) {
      log(`Updating Refine AI ${installedVersion} → ${latestVersion}...`)
    } else {
      log(`Installing Refine AI ${latestVersion}...`)
    }

    const pkgPath = path.join(os.tmpdir(), pkgAsset.name)
    await runWithLog('curl', ['-L', '--progress-bar', '-o', pkgPath, pkgAsset.browser_download_url], log, { env: this.env })

    log('Installing .pkg — a macOS password prompt will appear...')
    await runShell(
      `osascript -e 'do shell script "installer -pkg \\"${pkgPath}\\" -target /" with administrator privileges'`,
      log, undefined, this.env
    )

    log(`Refine AI ${latestVersion} installed ✓`)
    this.progress('refine-ai', 'done', `v${latestVersion}`)
    return { ok: true }
  }

  // ─────────────────────────────────────────────
  // PR steps
  // ─────────────────────────────────────────────

  private async saveGithubToken(token: string): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    if (!token || token.trim().length < 20) return { ok: false, error: 'Token too short' }
    const https = require('https')

    const username = await new Promise<string | null>((resolve) => {
      const req = https.get('https://api.github.com/user', {
        headers: {
          'Authorization': `token ${token.trim()}`,
          'User-Agent': 'metamask-designer-tools',
        },
      }, (res: any) => {
        let data = ''
        res.on('data', (chunk: any) => data += chunk)
        res.on('end', () => {
          try { resolve(JSON.parse(data).login ?? null) } catch { resolve(null) }
        })
      })
      req.on('error', () => resolve(null))
    })

    if (!username) return { ok: false, error: 'Could not validate token — make sure it has repo access.' }

    this.state.githubToken = token.trim()
    this.state.githubUsername = username
    this.saveState()
    return { ok: true, data: { username } }
  }

  private async checkCursor(): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    const installed = fs.existsSync('/Applications/Cursor.app')
    return { ok: true, data: { installed } }
  }

  private saveClaudeKey(key: string): { ok: boolean; error?: string } {
    if (!key || key.trim().length < 20) return { ok: false, error: 'Invalid API key' }
    this.state.claudeKey = key.trim()
    this.saveState()
    return { ok: true }
  }

  private async openCursor(file?: string): Promise<{ ok: boolean; error?: string }> {
    const log = this.log.bind(this)
    if (file) {
      const abs = path.join(REPO_DIR, file)
      await runShell(`open -a Cursor "${abs}" 2>/dev/null || open -a Cursor "${REPO_DIR}" 2>/dev/null || true`, log, undefined, this.env)
    } else {
      await runShell(`open -a Cursor "${REPO_DIR}" 2>/dev/null || true`, log, undefined, this.env)
    }
    return { ok: true }
  }

  private async prSync(): Promise<{ ok: boolean; error?: string }> {
    const log = this.log.bind(this)
    log('Checking out main...')

    // Switch to main first
    await runShell('git checkout main 2>/dev/null || true', log, REPO_DIR, this.env)

    // Hash package.json before pull to detect dep changes
    const pkgPath = path.join(REPO_DIR, 'package.json')
    const hashBefore = fs.existsSync(pkgPath)
      ? require('crypto').createHash('md5').update(fs.readFileSync(pkgPath)).digest('hex')
      : ''

    log('Pulling latest from main...')
    await runWithLog('git', ['pull', 'origin', 'main'], log, { cwd: REPO_DIR, env: this.env })

    const hashAfter = fs.existsSync(pkgPath)
      ? require('crypto').createHash('md5').update(fs.readFileSync(pkgPath)).digest('hex')
      : ''

    if (hashBefore && hashBefore !== hashAfter) {
      log('package.json changed — running yarn install...')
      await runWithLog('yarn', ['install'], log, { cwd: REPO_DIR, env: this.env })
      log('Dependencies updated ✓')
    } else {
      log('Dependencies are up to date ✓')
    }

    return { ok: true }
  }

  private async prCreateBranch(description: string): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    if (!description.trim()) return { ok: false, error: 'Branch description is required' }
    const log = this.log.bind(this)

    const username = this.state.githubUsername ?? 'designer'
    const slug = description.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const branchName = `${username}/${slug}`

    // Ensure on main before branching
    await runShell('git checkout main 2>/dev/null || true', log, REPO_DIR, this.env)

    log(`Creating branch ${branchName}...`)
    await runWithLog('git', ['checkout', '-b', branchName], log, { cwd: REPO_DIR, env: this.env })

    this.state.currentBranch = branchName
    this.saveState()

    log(`On branch ${branchName} ✓`)
    return { ok: true, data: { branchName } }
  }

  private async prChangedFiles(): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    const output = (() => {
      try {
        return require('child_process').execSync(
          'git status --porcelain',
          { encoding: 'utf8', cwd: REPO_DIR, env: this.env }
        ).trim()
      } catch { return '' }
    })()

    const files: string[] = output
      .split('\n')
      .filter(Boolean)
      .map((line: string) => line.slice(3).trim())
      .filter((f: string) => f.length > 0)

    // Find which changed files have corresponding test files
    const withSnapshots: string[] = []
    for (const file of files) {
      const dir = path.dirname(file)
      const base = path.basename(file, path.extname(file))
      const testCandidates = [
        path.join(REPO_DIR, dir, `${base}.test.tsx`),
        path.join(REPO_DIR, dir, `${base}.test.ts`),
        path.join(REPO_DIR, dir, '__tests__', `${base}.test.tsx`),
        path.join(REPO_DIR, dir, '__tests__', `${base}.test.ts`),
      ]
      if (testCandidates.some(p => fs.existsSync(p))) {
        withSnapshots.push(file)
      }
    }

    return { ok: true, data: { files, withSnapshots } }
  }

  private async prUpdateSnapshots(): Promise<{ ok: boolean; error?: string }> {
    const log = this.log.bind(this)

    const result = await this.prChangedFiles()
    if (!result.ok) return { ok: false, error: result.error }

    const { withSnapshots } = result.data as { files: string[]; withSnapshots: string[] }

    if (!withSnapshots || withSnapshots.length === 0) {
      log('No snapshot files to update ✓')
      return { ok: true }
    }

    for (const file of withSnapshots) {
      const dir = path.dirname(file)
      const base = path.basename(file, path.extname(file))

      const testFile = [
        path.join(dir, `${base}.test.tsx`),
        path.join(dir, `${base}.test.ts`),
        path.join(dir, '__tests__', `${base}.test.tsx`),
        path.join(dir, '__tests__', `${base}.test.ts`),
      ].find(p => fs.existsSync(path.join(REPO_DIR, p)))

      if (!testFile) continue

      log(`Updating snapshots for ${testFile}...`)
      try {
        await runShell(
          `npx jest "${testFile}" --updateSnapshot --testTimeout=30000 --forceExit`,
          log, REPO_DIR, this.env
        )
        log(`Snapshots updated for ${testFile} ✓`)
      } catch (e) {
        log(`Warning: snapshot update failed for ${testFile} — continuing`)
      }
    }

    log(`All snapshots updated ✓`)
    return { ok: true }
  }

  private async prCommitPush(message: string, prBody?: string): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    if (!message.trim()) return { ok: false, error: 'Commit message is required' }

    const branch = this.state.currentBranch
    if (!branch) return { ok: false, error: 'No branch set — create a branch first.' }

    const log = this.log.bind(this)
    const token = this.state.githubToken
    const username = this.state.githubUsername

    log('Staging all changes...')
    await runWithLog('git', ['add', '.'], log, { cwd: REPO_DIR, env: this.env })

    log(`Committing: "${message}"`)
    await runWithLog('git', ['commit', '-m', message], log, { cwd: REPO_DIR, env: this.env })

    log(`Pushing to origin/${branch}...`)
    const remote = token && username
      ? `https://${username}:${token}@github.com/MetaMask/metamask-mobile.git`
      : 'origin'

    await runWithLog('git', ['push', remote, branch], log, { cwd: REPO_DIR, env: this.env })

    log('Pushed ✓ — opening PR on GitHub...')

    // Build PR URL — include body if provided
    const bodyParam = prBody ? `&body=${encodeURIComponent(prBody)}` : ''
    const prUrl = `https://github.com/MetaMask/metamask-mobile/compare/${branch}?expand=1${bodyParam}`
    return { ok: true, data: { prUrl, branch } }
  }

  // ─────────────────────────────────────────────
  // Branch guard + update branch
  // ─────────────────────────────────────────────

  private async checkBranchGuard(): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    const currentBranch = (() => {
      try {
        return require('child_process').execSync(
          'git rev-parse --abbrev-ref HEAD',
          { encoding: 'utf8', cwd: REPO_DIR, env: this.env }
        ).trim()
      } catch { return 'unknown' }
    })()

    const onMain = currentBranch === 'main' || currentBranch === 'master'

    // Check if current branch is behind main (only if not on main)
    let behindMain = false
    if (!onMain && currentBranch !== 'unknown') {
      try {
        const behind = require('child_process').execSync(
          'git log HEAD..origin/main --oneline',
          { encoding: 'utf8', cwd: REPO_DIR, env: this.env }
        ).trim()
        behindMain = behind.length > 0
      } catch { behindMain = false }
    }

    return { ok: true, data: { currentBranch, onMain, behindMain } }
  }

  private async prUpdateBranch(): Promise<{ ok: boolean; error?: string }> {
    const log = this.log.bind(this)
    const branch = this.state.currentBranch

    if (!branch) return { ok: false, error: 'No branch set' }

    log(`Fetching latest main...`)
    await runWithLog('git', ['fetch', 'origin', 'main'], log, { cwd: REPO_DIR, env: this.env })

    log(`Merging origin/main into ${branch}...`)
    await runWithLog('git', ['merge', 'origin/main', '--no-edit'], log, { cwd: REPO_DIR, env: this.env })

    // Re-run yarn if package.json changed in the merge
    const pkgChanged = (() => {
      try {
        const out = require('child_process').execSync(
          'git diff HEAD~1 HEAD --name-only',
          { encoding: 'utf8', cwd: REPO_DIR, env: this.env }
        )
        return out.includes('package.json')
      } catch { return false }
    })()

    if (pkgChanged) {
      log('package.json changed — running yarn install...')
      await runWithLog('yarn', ['install'], log, { cwd: REPO_DIR, env: this.env })
    }

    log('Branch is up to date with main ✓')
    return { ok: true }
  }

  // ─────────────────────────────────────────────
  // Refine AI annotation reader (read-only)
  // ─────────────────────────────────────────────

  private async getRefineAnnotations(): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    const annotationsPath = path.join(
      os.homedir(), 'Library', 'Application Support', 'Refine AI', 'annotations.json'
    )

    if (!fs.existsSync(annotationsPath)) {
      return { ok: true, data: { annotations: [] } }
    }

    try {
      const raw = fs.readFileSync(annotationsPath, 'utf8')
      const all = JSON.parse(raw)
      // Only return pending annotations — resolved ones aren't relevant to this PR
      const pending = all.filter((a: any) => a.status === 'pending')
      return { ok: true, data: { annotations: pending } }
    } catch {
      return { ok: true, data: { annotations: [] } }
    }
  }

  // ─────────────────────────────────────────────
  // AI commit message generation via Claude
  // ─────────────────────────────────────────────

  private async generateCommitMessage(annotationsJson: string): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    const key = this.state.claudeKey
    if (!key) return { ok: false, error: 'No Claude API key set' }

    const log = this.log.bind(this)
    log('Reading diff...')

    // Get the diff — cap at 6000 chars to stay within token limits
    const diff = (() => {
      try {
        const out = require('child_process').execSync(
          'git diff HEAD',
          { encoding: 'utf8', cwd: REPO_DIR, env: this.env }
        )
        return out.slice(0, 6000)
      } catch { return '' }
    })()

    // Also get file list for context
    const fileList = (() => {
      try {
        return require('child_process').execSync(
          'git status --porcelain',
          { encoding: 'utf8', cwd: REPO_DIR, env: this.env }
        ).trim()
      } catch { return '' }
    })()

    let annotationContext = ''
    if (annotationsJson) {
      try {
        const annotations = JSON.parse(annotationsJson)
        if (annotations.length > 0) {
          annotationContext = '\n\nDesigner annotations these changes address:\n' +
            annotations.map((a: any) =>
              `- [${a.priority ?? 'medium'}] ${a.comment}${a.routeName ? ` (${a.routeName})` : ''}`
            ).join('\n')
        }
      } catch { /* ignore */ }
    }

    log('Generating commit message with Claude...')

    const { Anthropic } = require('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: key })

    const prompt = `You are helping a designer write a clear git commit message and GitHub PR description for changes to the MetaMask Mobile codebase.

Changed files:
${fileList || '(no file list available)'}

Git diff (may be truncated):
${diff || '(no diff available)'}${annotationContext}

Generate:
1. A concise commit message (max 72 chars, imperative tense, e.g. "Fix button padding on swap screen")
2. A short PR description (2-4 sentences in plain English explaining what changed and why, suitable for an engineer reviewer)

Respond with valid JSON only in this exact format:
{"commitMessage": "...", "prDescription": "..."}`

    const message = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = message.content[0].type === 'text' ? message.content[0].text : ''

    try {
      const parsed = JSON.parse(text.trim())
      log('Generated ✓')
      return { ok: true, data: { commitMessage: parsed.commitMessage, prDescription: parsed.prDescription } }
    } catch {
      // Claude returned text but not clean JSON — try to extract
      const commitMatch = text.match(/"commitMessage"\s*:\s*"([^"]+)"/)
      const descMatch = text.match(/"prDescription"\s*:\s*"([^"]+)"/)
      if (commitMatch) {
        return { ok: true, data: {
          commitMessage: commitMatch[1],
          prDescription: descMatch ? descMatch[1] : '',
        }}
      }
      return { ok: false, error: 'Could not parse Claude response' }
    }
  }
}
