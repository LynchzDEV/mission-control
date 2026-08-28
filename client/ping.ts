type PingPayload = {
  name: string
  at: number
}

export function ping(): PingPayload {
  const payload: PingPayload = { name: 'mission-control', at: Date.now() }
  console.log('[mission-control] ping', payload)
  return payload
}

ping()
