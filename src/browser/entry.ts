import { runBrowserWorker } from './worker.js'
try { await runBrowserWorker(process.argv[2]!) }
catch (error) { process.stderr.write(String(error)); process.exitCode = 1 }
