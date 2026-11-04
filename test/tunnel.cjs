'use strict'
// 自动连接（0.5，P11-01）：ssh 参数、报错说人话、连上 / 断了重连 / 用已有隧道 / 没设置
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Tunnel, sshArgs, explain, setupCommand } = require('../app/src/tunnel')

function fakeChild() {
  const c = new EventEmitter()
  c.stderr = new EventEmitter()
  c.killed = false
  c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', null)) }
  return c
}
const cfg = { host: 'example.org', port: 2222, user: 'atri-desk', localPort: 15160, remotePort: 5160, keyPath: 'K', knownHosts: 'KH' }
const tick = () => new Promise((r) => setImmediate(r))

;(async () => {
  const a = sshArgs(cfg)
  assert.deepEqual(a.slice(-3), ['-L', '127.0.0.1:15160:127.0.0.1:5160', 'atri-desk@example.org'])
  for (const o of ['BatchMode=yes', 'ExitOnForwardFailure=yes', 'StrictHostKeyChecking=accept-new', 'UserKnownHostsFile=KH', 'IdentitiesOnly=yes']) assert.ok(a.includes(o), o)
  assert.ok(a.includes('-N') && a[a.indexOf('-p') + 1] === '2222' && a[a.indexOf('-i') + 1] === 'K')
  assert.ok(!a.some((x) => /^-R|^-D/.test(x)), '只本地转发一个端口')

  assert.match(explain('root@x: Permission denied (publickey).'), /不认这把钥匙/)
  assert.match(explain('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!'), /指纹/)
  assert.match(explain('bind [127.0.0.1]:15160: Address already in use'), /端口被占用/)
  assert.match(explain('ssh: connect to host x port 22: Connection timed out'), /超时/)
  assert.match(explain('channel 2: open failed: administratively prohibited'), /拒绝转发/)
  assert.match(explain('\n__probe_timeout__'), /打不通 Atri/)
  assert.match(explain('', 255), /255/)
  assert.equal(setupCommand("ssh-ed25519 AAAA atri-desk@pc'"), "bash /opt/atri/deploy/desk-account.sh 'ssh-ed25519 AAAA atri-desk@pc'")

  // 没设置
  const t0 = new Tunnel({ config: () => null, probe: async () => false, spawn: () => assert.fail('不该开 ssh'), sleep: tick })
  await t0.start()
  assert.equal(t0.state.phase, 'setup')

  // 本机端口上已经有能用的隧道：直接用，不开 ssh
  const t1 = new Tunnel({ config: () => cfg, probe: async () => true, spawn: () => assert.fail('不该开 ssh'), sleep: tick })
  await t1.start()
  assert.equal(t1.state.phase, 'connected')
  assert.equal(t1.state.external, true)
  t1.stop()

  // 开 ssh，起来后能打招呼 = 连上
  let up = false
  let spawned = []
  const t2 = new Tunnel({ config: () => cfg, probe: async () => up, spawn: (cmd, args) => { spawned.push(cmd); const c = fakeChild(); setTimeout(() => (up = true), 5); return c }, sleep: (ms) => new Promise((r) => setTimeout(r, 5)), sshPath: 'ssh.exe' })
  await t2.start()
  assert.deepEqual(spawned, ['ssh.exe'])
  assert.equal(t2.state.phase, 'connected')
  assert.equal(t2.state.external, false)
  t2.stop()
  assert.equal(t2.state.phase, 'idle')

  // 钥匙没加到服务器：ssh 报错退出 → 说清楚原因，等一会儿再试（不会一直狂连）
  const states = []
  let child
  const t3 = new Tunnel({ config: () => cfg, probe: async () => false, spawn: () => { child = fakeChild(); return child }, sleep: (ms) => new Promise((r) => setTimeout(r, 1)) })
  t3.on('state', (s) => states.push(s.phase))
  const p = t3.start()
  await tick()
  child.stderr.emit('data', Buffer.from('atri-desk@x: Permission denied (publickey).\n'))
  child.emit('exit', 255)
  await p
  assert.equal(t3.state.phase, 'waiting')
  assert.match(t3.state.error, /不认这把钥匙/)
  assert.equal(t3.state.retryIn, 3)
  t3.stop()
  assert.equal(t3.state.phase, 'idle', '停了就不再重连')

  // 退避：失败越多等越久，最长 60 秒
  const t4 = new Tunnel({ config: () => cfg, probe: async () => false, spawn: () => fakeChild(), sleep: tick })
  t4.stopped = false
  const waits = []
  for (let i = 0; i < 8; i++) { t4.retryLater('x', 'y'); waits.push(t4.state.retryIn) }
  t4.stop()
  assert.deepEqual(waits, [3, 5, 10, 20, 40, 60, 60, 60])
  console.log('TUNNEL OK: ssh args, error messages, existing tunnel, connect, retry/backoff, stop')
})().catch((e) => { console.error(e); process.exit(1) })
