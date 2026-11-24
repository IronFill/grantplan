import raw from './granty.json';
import { effectiveStatus, sortPrograms } from '../lib/granty.js';

// Безкоштовна частина каталогу. Джерело — приватна база, див. src/lib/granty.js.

export interface GrantProgram {
  id: string;
  title: string;
  short: string;
  operator: { name: string | null; url: string | null };
  kind: 'grant' | 'loan' | 'compensation' | 'support';
  source_type: string;
  status: 'open' | 'rolling' | 'closed' | 'expected' | 'unknown';
  period: { opens: string | null; closes: string | null };
  last_checked: string;
  amount: { min: number | null; max: number | null; cap: number | null; currency: string | null };
  entities: string[];
  categories: string[];
  regions: string[];
  sectors: string[];
  verified: boolean;
  replaced_by: string | null;
}

export const grantsGeneratedAt: string = raw.generated;
export const grantPrograms = raw.programs as GrantProgram[];

export const todayIso = () => new Date().toISOString().slice(0, 10);

export function sortedGrants(today = todayIso()): GrantProgram[] {
  return sortPrograms(grantPrograms, today) as GrantProgram[];
}

export function grantCounts(today = todayIso()) {
  const open = grantPrograms.filter((p) => ['open', 'rolling'].includes(effectiveStatus(p, today))).length;
  const closed = grantPrograms.filter((p) => effectiveStatus(p, today) === 'closed').length;
  return { total: grantPrograms.length, open, closed, other: grantPrograms.length - open - closed };
}

export function grantById(id: string): GrantProgram | undefined {
  return grantPrograms.find((p) => p.id === id);
}
