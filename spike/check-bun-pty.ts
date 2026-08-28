import { spawn } from 'bun-pty'

async function checkEcho(): Promise<string> {
  return new Promise((resolve, reject) => {
    const term = spawn('/bin/echo', ['hello'], { name: 'xterm-color', cols: 80, rows: 24 })
    let out = ''
    term.onData((d) => (out += d))
    term.onExit(() => resolve(out))
    setTimeout(() => reject(new Error('echo pty timeout, got: ' + JSON.stringify(out))), 5000)
  })
}

async function checkInteractiveShell(): Promise<string> {
  return new Promise((resolve, reject) => {
    const shell = spawn('/bin/sh', [], { name: 'xterm-color', cols: 80, rows: 24 })
    let out = ''
    shell.onData((d) => {
      out += d
      if (out.includes('hi')) {
        shell.kill()
        resolve(out)
      }
    })
    shell.write('echo hi\n')
    setTimeout(() => {
      shell.kill()
      reject(new Error('interactive shell timeout, got: ' + JSON.stringify(out)))
    }, 5000)
  })
}

async function main() {
  const echoOut = await checkEcho()
  console.log('ECHO_PTY_OUTPUT', JSON.stringify(echoOut))
  if (!echoOut.includes('hello')) throw new Error('echo pty check FAILED: no hello in output')

  const shellOut = await checkInteractiveShell()
  console.log('SHELL_PTY_OUTPUT', JSON.stringify(shellOut))
  if (!shellOut.includes('hi')) throw new Error('interactive shell pty check FAILED')

  console.log('BUN_PTY_CHECK: PASS')
}

await main()
