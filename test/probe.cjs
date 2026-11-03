const ENV = require('node:path').resolve(__dirname, '../env/node_modules') + '/'
const { App } = require(ENV + 'koishi')
const app = new App({})
console.log('http?', !!app.http, 'db?', !!app.database)
const fork = app.plugin(require(ENV + 'koishi-plugin-hds-interlude'), {})
app.start().then(() => { setTimeout(() => { console.log('interlude', !!app.interlude, fork.status, fork.runtime && fork.runtime.isActive, fork.runtime && fork.runtime.using, fork.runtime && fork.runtime.inject); process.exit(0) }, 2000) })
