const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const S = (d: React.ReactNode) => (props: { size?: number }) => (
  <svg width={props.size ?? 18} height={props.size ?? 18} viewBox="0 0 24 24" aria-hidden="true" {...P}>{d}</svg>
);
export const IPlay = S(<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none" />);
export const IPause = S(<><rect x="7" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" stroke="none" /><rect x="13.6" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" stroke="none" /></>);
export const IFile = S(<><path d="M9 18V6l10-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" /></>);
export const IMic = S(<><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" /></>);
export const ISpark = S(<path d="M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9z" />);
export const ISettings = S(<><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>);
export const IPerf = S(<path d="M3.5 13h4l2.5-6 4 11 2.5-5h4" />);
export const IFull = S(<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />);
export const IExitFull = S(<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />);
export const ICamera = S(<><path d="M3.5 8.5h11v9h-11z" /><path d="M14.5 11.5l6-3.5v10l-6-3.5" /></>);
export const IFreeze = S(<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" />);
export const IClose = S(<path d="M6 6l12 12M18 6L6 18" />);
export const IWorlds = S(<><circle cx="12" cy="12" r="8.5" /><ellipse cx="12" cy="12" rx="8.5" ry="3.2" /></>);
export const IScreen = S(<><rect x="3.5" y="4.5" width="17" height="11.5" rx="1.5" /><path d="M9 20h6M12 16v4" /></>);
export const IFamilies = S(<><circle cx="6" cy="7" r="1.6" /><path d="M10 7h9" /><circle cx="6" cy="12" r="1.6" /><path d="M10 12h6" /><circle cx="6" cy="17" r="1.6" /><path d="M10 17h8" /></>);
export const IMix = S(<><circle cx="7.5" cy="12" r="4.5" /><circle cx="7.5" cy="12" r="1" /><circle cx="16.5" cy="12" r="4.5" /><circle cx="16.5" cy="12" r="1" /></>);
export const ISkip = S(<><path d="M5 6.5l8 5.5-8 5.5z" /><path d="M17.5 6v12" /></>);
export const IPlus = S(<path d="M12 5v14M5 12h14" />);
