const TS_SYNTAX_MARKERS = [': WidgetProps', ': Promise<void>', 'interface ', ': HTMLElement']

async function main() {
  const result = await Bun.build({
    entrypoints: ['spike/fixtures/sample-client.ts'],
    target: 'browser',
    write: false,
  })

  if (!result.success) {
    console.error('BUILD_LOGS', result.logs)
    throw new Error('Bun.build FAILED')
  }

  const output = result.outputs[0]
  const code = await output.text()
  console.log('OUTPUT_LENGTH', code.length)
  console.log('OUTPUT_SNIPPET', code.slice(0, 300))

  for (const marker of TS_SYNTAX_MARKERS) {
    if (code.includes(marker)) {
      throw new Error(`BUN_BUILD_CHECK FAILED: TS syntax marker "${marker}" leaked into output`)
    }
  }

  console.log('BUN_BUILD_CHECK: PASS')
}

await main()
