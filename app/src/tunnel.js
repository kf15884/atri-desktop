'use strict'
/**
 * 自动连接（0.5，P11-01）：桌面一打开就用 Windows 自带的 ssh 和一把专用钥匙，建一条到服务器桌面入口的隧道，断了自动重连。
 * - 服务器上的专用账号（deploy/desk-account.sh 建的）只能转发到 127.0.0.1:5160，不能登录、不能执行命令
 * - 只用钥匙（BatchMode，不会弹出要密码）；服务器指纹第一次连时记下（应用自己的 known_hosts），以后变了就不连并说清楚
 * - 本机端口已经有一条能用的隧道（比如你自己手动开的），就直接用，不另开
 * 这里不碰 Electron，spawn、探测、计时都可以换成假的来测。
 */
const { EventEmitter } = require('node:events')

const BACKOFF = [3, 5, 10, 20, 40, 60]

/** ssh 的参数：只转发一个端口，不要终端、不要密码 */
function sshArgs(c) {
  return [
    '-N',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=15',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'UserKnownHostsFile=' + c.knownHosts,
    '-i', c.keyPath,
    '-p', String(c.port || 22),
    '-L', `127.0.0.1:${c.localPort}:127.0.0.1:${c.remotePort}`,
    `${c.user}@${c.host}`,
  ]
}

/** ssh 退出时的报错 → 人话 */
function explain(stderr, code) {
  const s = String(stderr || '')
  if (s.includes('__probe_timeout__') && !/Permission|refused|timed out|resolve/i.test(s)) return '隧道开了但打不通 Atri：服务器上 atri-self 的桌面入口开着吗（ATRI_DESK_TOKEN），或者口令不对'
  if (/Permission denied/i.test(s)) return '服务器不认这把钥匙：把“连接钥匙”交给服务器上的设置脚本了吗'
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(s)) return '服务器的指纹和第一次连的时候不一样了，为了安全没连。确定服务器重装过，就在设置里点“忘掉服务器指纹”'
  if (/Address already in use|cannot listen to port|bind.*failed/i.test(s)) return '本机端口被占用了（可能别的程序或你自己开的隧道在用），换个本机端口试试'
  if (/administratively prohibited|open failed/i.test(s)) return '服务器拒绝转发：专用账号只能转到桌面入口，检查服务器上的桌面端口设置'
  if (/Could not resolve hostname/i.test(s)) return '找不到这个服务器地址'
  if (/Connection timed out|Operation timed out|timed out/i.test(s)) return '连服务器超时（网断了，或者服务器没开）'
  if (/Connection refused/i.test(s)) return '服务器拒绝连接（ssh 端口不对，或者 sshd 没开）'
  if (/UNPROTECTED PRIVATE KEY|bad permissions/i.test(s)) return '钥匙文件的权限太宽，ssh 不肯用；在设置里重新生成一把'
  if (/not recognized|ENOENT|no such file/i.test(s)) return '没找到 Windows 自带的 ssh（设置 → 应用 → 可选功能 → 安装“OpenSSH 客户端”）'
  const last = s.trim().split('\n').filter(Boolean).pop()
  return last ? last.slice(0, 200) : `ssh 退出了（${code}）`
}

class Tunnel extends EventEmitter {
  /**
   * @param {object} d
   *   config(): {host, port, user, localPort, remotePort, keyPath, knownHosts} | null（没配好）
   *   spawn(cmd, args): 子进程（stderr、on('exit')、kill()）
   *   probe(localPort): Promise<boolean>（本机这个端口上能不能跟 Atri 打招呼）
   *   sshPath: ssh 程序
   */
  constructor(d) {
    super()
    this.d = d
    this.child = null
    this.state = { phase: 'idle', label: '还没开始连', since: Date.now(), error: null, external: false }
    this.failures = 0
    this.timer = null
    this.stopped = true
    this.gen = 0
  }

  set(phase, label, extra = {}) {
    this.state = { phase, label, since: Date.now(), error: null, external: false, ...extra }
    this.emit('state', this.state)
  }

  async start() {
    this.stopped = false
    await this.connect()
  }

  stop() {
    this.stopped = true
    this.gen++
    clearTimeout(this.timer)
    if (this.child) {
      try { this.child.kill() } catch {}
      this.child = null
    }
    this.set('idle', '没连')
  }

  /** 设置改了：断开重连 */
  async restart() {
    this.stop()
    this.failures = 0
    await this.start()
  }

  retryLater(label, error) {
    if (this.stopped) return
    const sec = BACKOFF[Math.min(this.failures, BACKOFF.length - 1)]
    this.failures++
    this.set('waiting', `${label}（${sec} 秒后再试）`, { error, retryIn: sec })
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.connect(), sec * 1000)
    if (this.timer.unref) this.timer.unref()
  }

  async connect() {
    if (this.stopped) return
    const gen = ++this.gen
    const c = this.d.config()
    if (!c) return this.set('setup', '还没设置服务器地址和连接钥匙')
    // 本机端口上已经有一条能用的（你自己开的隧道）：直接用
    if (await this.d.probe(c.localPort).catch(() => false)) {
      if (gen !== this.gen) return
      this.failures = 0
      this.set('connected', '连上了（用的是本机已有的隧道）', { external: true })
      this.watch(gen, c)
      return
    }
    this.set('connecting', '正在连服务器…')
    let stderr = ''
    let child
    try {
      child = this.d.spawn(this.d.sshPath, sshArgs(c))
    } catch (e) {
      return this.retryLater('没开起来 ssh', explain(e.message))
    }
    this.child = child
    child.stderr?.on('data', (b) => { stderr = (stderr + b.toString()).slice(-4000) })
    child.on('error', (e) => { stderr += '\n' + e.message })
    child.on('exit', (code) => {
      if (this.child === child) this.child = null
      if (gen !== this.gen || this.stopped) return
      this.retryLater('断了', explain(stderr, code))
    })
    // 隧道起来后能打招呼才算连上（最多等 20 秒）
    for (let i = 0; i < 20; i++) {
      await (this.d.sleep ? this.d.sleep(1000) : new Promise((r) => setTimeout(r, 1000)))
      if (gen !== this.gen || this.child !== child) return
      if (await this.d.probe(c.localPort).catch(() => false)) {
        this.failures = 0
        this.set('connected', '连上了')
        this.watch(gen, c)
        return
      }
    }
    if (gen !== this.gen) return
    stderr += '\n__probe_timeout__'
    try { child.kill() } catch {}
  }

  /** 连上以后每 30 秒打个招呼；不通了就重连（ssh 自己断了的由 exit 处理） */
  watch(gen, c) {
    clearTimeout(this.timer)
    this.timer = setTimeout(async () => {
      if (gen !== this.gen || this.stopped) return
      const ok = await this.d.probe(c.localPort).catch(() => false)
      if (gen !== this.gen || this.stopped) return
      if (ok) return this.watch(gen, c)
      if (this.child) { try { this.child.kill() } catch {} ; return }
      this.retryLater('连不上了', this.state.external ? '你自己开的那条隧道断了，改用自动连接' : '打不通 Atri')
    }, 30000)
    if (this.timer.unref) this.timer.unref()
  }
}

/** 服务器上设置脚本要的那一行：用户把它整行交给 desk-account.sh */
function setupCommand(pub) {
  return `bash /opt/atri/deploy/desk-account.sh '${String(pub).trim().replace(/'/g, '')}'`
}

module.exports = { Tunnel, sshArgs, explain, setupCommand, BACKOFF }
