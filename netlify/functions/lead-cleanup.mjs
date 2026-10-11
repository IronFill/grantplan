import { getStore } from '@netlify/blobs';
import { pruneLeads } from '../../src/lib/lead-retention.js';

export default async () => {
  const removed = await pruneLeads(getStore({ name: 'grantplan-leads', consistency: 'strong' }));
  console.log('Lead retention cleanup completed:', removed);
};
export const config = { schedule: '@daily' };
