// Every Asian and Oceanian country/territory a player can pick (ISO 3166-1 alpha-2 codes).
// Players store the code; the flag image comes from flagcdn.com because Windows doesn't render emoji flags.

export interface Country { code: string; name: string }

export const ASIA: Country[] = [
  ['AF', 'Afghanistan'], ['AM', 'Armenia'], ['AZ', 'Azerbaijan'], ['BH', 'Bahrain'], ['BD', 'Bangladesh'], ['BT', 'Bhutan'],
  ['BN', 'Brunei'], ['KH', 'Cambodia'], ['CN', 'China'], ['CY', 'Cyprus'], ['GE', 'Georgia'], ['HK', 'Hong Kong'],
  ['IN', 'India'], ['ID', 'Indonesia'], ['IR', 'Iran'], ['IQ', 'Iraq'], ['IL', 'Israel'], ['JP', 'Japan'], ['JO', 'Jordan'],
  ['KZ', 'Kazakhstan'], ['KW', 'Kuwait'], ['KG', 'Kyrgyzstan'], ['LA', 'Laos'], ['LB', 'Lebanon'], ['MO', 'Macau'],
  ['MY', 'Malaysia'], ['MV', 'Maldives'], ['MN', 'Mongolia'], ['MM', 'Myanmar'], ['NP', 'Nepal'], ['KP', 'North Korea'],
  ['OM', 'Oman'], ['PK', 'Pakistan'], ['PS', 'Palestine'], ['PH', 'Philippines'], ['QA', 'Qatar'], ['SA', 'Saudi Arabia'],
  ['SG', 'Singapore'], ['KR', 'South Korea'], ['LK', 'Sri Lanka'], ['SY', 'Syria'], ['TW', 'Taiwan'], ['TJ', 'Tajikistan'],
  ['TH', 'Thailand'], ['TL', 'Timor-Leste'], ['TR', 'Turkey'], ['TM', 'Turkmenistan'], ['AE', 'United Arab Emirates'],
  ['UZ', 'Uzbekistan'], ['VN', 'Vietnam'], ['YE', 'Yemen'],
].map(([code, name]) => ({ code, name }));

export const OCEANIA: Country[] = [
  ['AS', 'American Samoa'], ['AU', 'Australia'], ['CK', 'Cook Islands'], ['FJ', 'Fiji'], ['PF', 'French Polynesia'],
  ['GU', 'Guam'], ['KI', 'Kiribati'], ['MH', 'Marshall Islands'], ['FM', 'Micronesia'], ['NR', 'Nauru'],
  ['NC', 'New Caledonia'], ['NZ', 'New Zealand'], ['NU', 'Niue'], ['NF', 'Norfolk Island'], ['MP', 'Northern Mariana Islands'],
  ['PW', 'Palau'], ['PG', 'Papua New Guinea'], ['PN', 'Pitcairn Islands'], ['WS', 'Samoa'], ['SB', 'Solomon Islands'],
  ['TK', 'Tokelau'], ['TO', 'Tonga'], ['TV', 'Tuvalu'], ['VU', 'Vanuatu'], ['WF', 'Wallis and Futuna'],
].map(([code, name]) => ({ code, name }));

const ALL = [...ASIA, ...OCEANIA];
const BY_CODE = new Map(ALL.map((c) => [c.code, c]));
const BY_NAME = new Map(ALL.map((c) => [c.name.toLowerCase(), c]));

/** Resolves a stored value (an ISO code, or free text saved before the dropdown existed) to a country. */
export function findCountry(value?: string | null): Country | null {
  const v = (value || '').trim();
  if (!v) return null;
  return BY_CODE.get(v.toUpperCase()) || BY_NAME.get(v.toLowerCase()) || null;
}
