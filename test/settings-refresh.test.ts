import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
test('saved roles refresh pristine forms and model choices while preserving edited forms', async () => {
  const built = await Bun.build({entrypoints:['client/model-picker.ts'],target:'browser',format:'cjs'}); expect(built.success).toBe(true)
  class Field {
    value = ''; defaultValue = ''; checked = false; defaultChecked = false; type = ''; hidden = false; dataset: Record<string,string> = {}; textContent = ''
    options: any[] = []; form: Field | null = null; fields: Field[] = []; listeners = new Map<string,Array<() => void>>()
    addEventListener(name:string,fn:() => void) { this.listeners.set(name,[...this.listeners.get(name) ?? [],fn]) }
    fire(name:string) { for (const fn of this.listeners.get(name) ?? []) fn() }
    querySelectorAll() { return this.fields }
    append(option:any) { this.options.push(option) }
    replaceChildren() { this.options = [] }
  }
  const nodes = new Map<string,Field>(), picks: Field[] = []
  for (const [engineId,modelId] of [['engine','model'],['term-engine','term-model']]) {
    const form = new Field(), engine = new Field(), model = new Field(), pick = new Field()
    engine.options = ['claude','codex'].map(value => ({value,selected:value === 'claude',defaultSelected:value === 'claude'})); engine.value = 'claude'; model.value = model.defaultValue = 'old'
    engine.form = model.form = form; form.fields = [model]
    pick.dataset = {modelFor:engineId!,modelInput:modelId!}; picks.push(pick)
    nodes.set(engineId!,engine); nodes.set(modelId!,model)
  }
  const script = new Field(); script.textContent = JSON.stringify({claude:['old'],codex:[]}); nodes.set('model-lists',script)
  const events = new Map<string,(event?:any) => void>(), requests: string[] = []
  const module = {exports:{} as {installModelPickers():void}}
  runInNewContext(await built.outputs[0]!.text(), {
    module,exports:module.exports,HTMLInputElement:Field,CSS:{escape:(value:string) => value},queueMicrotask,
    document:{querySelector:(selector:string) => nodes.get(selector.slice(1)) ?? null,querySelectorAll:() => picks,getElementById:(id:string) => nodes.get(id),createElement:() => new Field()},
    addEventListener:(name:string,fn:any) => events.set(name,fn),
    fetch:async (url:string) => { requests.push(url); return {ok:true,json:async () => url === '/api/roles' ? {plan:{engine:'codex',model:'new'},execute:{engine:'codex',model:'new'}} : {claude:['old'],codex:['new']}} },
  })
  module.exports.installModelPickers()
  const edited = nodes.get('model')!; edited.value = 'my-draft-model'; edited.form!.fire('input')
  events.get('mc:settings-refresh')!()
  for (let i=0;i<25;i++) await Promise.resolve()
  expect(requests).toEqual(['/api/roles','/api/models'])
  expect(nodes.get('term-engine')!.value).toBe('codex'); expect(nodes.get('term-model')!.value).toBe('new')
  expect(nodes.get('engine')!.value).toBe('claude'); expect(edited.value).toBe('my-draft-model')
  expect(edited.defaultValue).toBe('new')
  expect(picks[1]!.options.map(option => option.value)).toContain('new')
})
