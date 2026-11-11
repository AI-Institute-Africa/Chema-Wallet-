// Conversation rows and their sealed data. Minimum conversation memory
// (docs/09): the current form, the numbered options last shown, and the
// contribution ids made from this conversation (so it can show their receipts).
import { NotFoundError } from '@chema/core';
import { isLocale, type Locale, type Queryable } from '@chema/shared';
import { openText, sealText, type WaKeys } from './util';

export type OfferReason = 'DISTRESS' | 'COMPLAINT' | 'FRAUD' | 'MISUNDERSTOOD';

export interface ConvData {
  /** When the current state was entered (ISO). Idle forms expire. */
  stateAt?: string;
  /** Fields of the form being filled. */
  form?: Record<string, string>;
  /** Ids behind the numbers last shown (wallets, payees, rails...). */
  options?: string[];
  /** Contribution ids started here, newest last (max 20). */
  contribs?: string[];
  offer?: OfferReason;
}

export interface ConvRow {
  id: string;
  phone_hash: string;
  phone_sealed: string;
  auth_session_id: string | null;
  person_id: string | null;
  locale: string;
  state: string;
  data_sealed: string | null;
  misunderstood: number;
  rate_window_start: Date | null;
  rate_count: number;
}

export interface Conversation {
  id: string;
  phone: string;
  authSessionId: string | null;
  personId: string | null;
  locale: Locale;
  state: string;
  data: ConvData;
  misunderstood: number;
}

export const CONV_COLS = 'id, phone_hash, phone_sealed, auth_session_id, person_id, locale, state, data_sealed, misunderstood, rate_window_start, rate_count';

export const phoneAad = (id: string) => `wa:conv:phone:${id}`;
export const dataAad = (id: string) => `wa:conv:data:${id}`;
export const bodyAad = (id: string) => `wa:in:body:${id}`;
export const handoffAad = (id: string) => `wa:handoff:ctx:${id}`;

export function decodeConversation(keys: WaKeys, r: ConvRow): Conversation {
  return {
    id: r.id,
    phone: openText(keys, r.phone_sealed, phoneAad(r.id)),
    authSessionId: r.auth_session_id,
    personId: r.person_id,
    locale: isLocale(r.locale) ? r.locale : 'en',
    state: r.state,
    data: r.data_sealed ? (JSON.parse(openText(keys, r.data_sealed, dataAad(r.id))) as ConvData) : {},
    misunderstood: r.misunderstood,
  };
}

export async function loadConversation(q: Queryable, keys: WaKeys, id: string, lock = false): Promise<Conversation> {
  const { rows } = await q.query<ConvRow>(`SELECT ${CONV_COLS} FROM wa_conversation WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw new NotFoundError('wa_conversation', id);
  return decodeConversation(keys, rows[0]);
}

export const sealData = (keys: WaKeys, id: string, data: ConvData) => sealText(keys, JSON.stringify(data), dataAad(id));
