'use client';
// Upload the documents community verification needs, then send for checks.
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, type EvidenceType } from '../../../../lib/api';
import { EVIDENCE_COPY, missingLine } from '../../../../lib/copy';
import { api } from '../../../../lib/session';

const TYPES: EvidenceType[] = ['DEATH_CERTIFICATE', 'PARLOUR_CONFIRMATION', 'BURIAL_ORDER', 'ADMIN_ID', 'MANDATE', 'OTHER'];
const ACCEPT = 'application/pdf,image/jpeg,image/png';

export default function Evidence() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [type, setType] = useState<EvidenceType>('DEATH_CERTIFICATE');
  const [file, setFile] = useState<File | null>(null);
  const [certNo, setCertNo] = useState('');
  const [uploaded, setUploaded] = useState<EvidenceType[]>([]);
  const [missing, setMissing] = useState<readonly string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const cert = type === 'DEATH_CERTIFICATE' && certNo.trim() ? certNo.trim() : undefined;
      await api.addEvidence(id, type, file.type, bytes, cert);
      setUploaded([...uploaded, type]);
      setFile(null);
      setCertNo('');
    } catch {
      setMessage('Upload failed. Use a PDF, JPEG or PNG under 5 MB.');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setMessage(null);
    setMissing([]);
    try {
      await api.submit(id);
      router.push(`/wallets/${id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'missing_evidence') setMissing(e.missing);
      else setMessage('Could not send for checks. Please try again.');
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Documents for community checks</h1>
      <p className="muted">
        We need one proof of death, your ID, and a family mandate showing you may manage this wallet. Documents are encrypted and seen
        only by the people reviewing them.
      </p>
      <div className="card">
        <label htmlFor="type">Document type</label>
        <select id="type" value={type} onChange={(e) => setType(e.target.value as EvidenceType)}>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {EVIDENCE_COPY[t]}
            </option>
          ))}
        </select>
        {type === 'DEATH_CERTIFICATE' && (
          <>
            <label htmlFor="cert">Certificate number (optional)</label>
            <input id="cert" maxLength={64} value={certNo} onChange={(e) => setCertNo(e.target.value)} />
          </>
        )}
        <label htmlFor="file">File</label>
        <input id="file" type="file" accept={ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button onClick={upload} disabled={!file || busy}>
          Upload
        </button>
      </div>
      {uploaded.length > 0 && (
        <div className="card">
          <h2>Uploaded</h2>
          <ul className="plain">
            {uploaded.map((t, i) => (
              <li key={`${t}-${i}`}>{EVIDENCE_COPY[t]}</li>
            ))}
          </ul>
        </div>
      )}
      <button onClick={submit} disabled={busy}>
        Send for community checks
      </button>
      {missing.length > 0 && (
        <div className="card">
          <p className="error">Still needed:</p>
          <ul>
            {missing.map((m) => (
              <li key={m}>{missingLine(m)}</li>
            ))}
          </ul>
        </div>
      )}
      {message && <p className="error">{message}</p>}
      <p>
        <Link href={`/wallets/${id}`}>View wallet status</Link>
      </p>
    </main>
  );
}
