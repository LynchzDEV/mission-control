import type { ReactNode } from 'react'
export function Icon({name='spark',size=18}:{name?:string;size?:number}) {
  const paths:Record<string,ReactNode> = {
    spark:<><path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7Z"/><path d="m20 2 .5 1.5L22 4l-1.5.5L20 6l-.5-1.5L18 4l1.5-.5Z"/></>,
    plan:<><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></>,
    check:<><path d="m5 12 4 4L19 6"/><circle cx="12" cy="12" r="10"/></>,
    code:<><path d="m7 6-5 6 5 6m10-12 5 6-5 6m-3-14-4 16"/></>,
    review:<><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
    research:<><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/></>,
    test:<><path d="m8 3 8 0M10 3v6L4 19q-1 2 2 2h12q3 0 2-2L14 9V3M7 15h10"/></>,
    plus:<path d="M12 5v14M5 12h14"/>,
    arrow:<path d="M4 12h16m-6-6 6 6-6 6"/>,
    back:<path d="M20 12H4m6-6-6 6 6 6"/>,
    close:<path d="m6 6 12 12M6 18 18 6"/>,
    clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    lock:<><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    play:<path d="m8 4 12 8-12 8Z"/>,
    layers:<><path d="m12 3 10 5-10 5L2 8Zm-10 10 10 5 10-5M2 18l10 5 10-5"/></>,
    folder:<path d="M3 6h7l2 3h9v11H3Z"/>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]??paths.spark}</svg>
}
