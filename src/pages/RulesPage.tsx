import { useMemo } from 'react';
import { marked } from 'marked';
import { useDoc } from '../lib/hooks';
import { BRAND } from '../lib/config';
import { fmtAgo } from '../lib/format';
import { PageHeader, Empty, Skeleton } from '../components/ui';

type RulesDoc = { markdown?: string; updatedAt?: { toMillis(): number } };

/** League rules, written by admins in Admin → Rules. */
export default function RulesPage() {
  const { data: rules, loading } = useDoc<RulesDoc>('content/rules');
  const md = rules?.markdown?.trim() || '';
  // Escape raw HTML (same as the admin preview) so only markdown formatting renders.
  const html = useMemo(() => (md ? (marked.parse(md.replace(/</g, '&lt;'), { async: false }) as string) : ''), [md]);
  return (
    <>
      <PageHeader eyebrow={BRAND.appName} title="League" accent="rules"
        meta={rules?.updatedAt ? <span className="small muted">Updated {fmtAgo(rules.updatedAt)}</span> : undefined} />
      <main className="page">
        <section>
          {loading ? <Skeleton /> : html
            ? <div className="card markdown" dangerouslySetInnerHTML={{ __html: html }} />
            : <Empty>The league rules haven't been posted yet.</Empty>}
        </section>
      </main>
    </>
  );
}
