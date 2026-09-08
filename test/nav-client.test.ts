import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
test('embedded keyboard navigation works without tabs and suppresses editable targets', async () => {
  const result = await Bun.build({entrypoints:['client/nav.ts'],target:'browser',format:'iife',write:false})
  expect(result.success).toBe(true)
  let keydown: (event:any) => void = () => {}
  const events: any[] = []
  class Element { constructor(public tagName:string,public isContentEditable=false) {} }
  runInNewContext(await result.outputs[0]!.text(), { HTMLElement:Element, document:{querySelector:() => null},addEventListener:(_name:string,callback:any) => {keydown=callback},dispatchEvent:(event:any) => events.push(event),CustomEvent:class { constructor(public name:string,public options:any) {} } })
  keydown({key:'1',target:new Element('BUTTON'),preventDefault(){}})
  expect(events[0].options.detail).toBe('/lanes')
  for (const target of [new Element('INPUT'),new Element('TEXTAREA'),new Element('SELECT'),new Element('DIV',true)]) keydown({key:'2',target,preventDefault(){}})
  expect(events).toHaveLength(1)
})
