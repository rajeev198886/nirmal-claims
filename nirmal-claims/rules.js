'use strict';
// Routing rules: the warranty policy (sections 2, 4, 8, 9) turned into code.

const QUEUES = ['Fast lane', 'Detailed review', 'Needs info', 'Duplicate hold', 'Out of warranty'];
const DEMO_DATE = '2026-10-20';
const FAST_LIMIT = 5000;
const LATE_DAYS = 15;

const pad = (n) => String(n).padStart(2, '0');
const parts = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
};

function addMonths(iso, months) {
  const { y, m, d } = parts(iso);
  const t = y * 12 + (m - 1) + months;
  const ny = Math.floor(t / 12);
  const nm = t % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, last))}`;
}

function daysBetween(a, b) {
  const A = parts(a);
  const B = parts(b);
  return Math.round((Date.UTC(B.y, B.m - 1, B.d) - Date.UTC(A.y, A.m - 1, A.d)) / 86400000);
}

function coverMonths(c) {
  const extended =
    (c.component === 'compressor' && (c.product === 'Air conditioner' || c.product === 'Refrigerator')) ||
    (c.component === 'motor' && c.product === 'Washing machine');
  return extended ? 60 : 12;
}

function missingDocs(c) {
  const names = { job_sheet: 'job sheet', invoice: 'invoice', serial_photo: 'serial photo' };
  return Object.keys(names).filter((k) => !c.docs[k]).map((k) => names[k]);
}

const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');

// Returns { queue, why } - first matching rule wins.
function routeClaim(c, threshold) {
  if (c.duplicate_of !== null && c.duplicate_of !== undefined) {
    return { queue: 'Duplicate hold', why: `Duplicate of claim #${c.duplicate_of} (same serial and job date)` };
  }
  const missing = missingDocs(c);
  if (missing.length) {
    return { queue: 'Needs info', why: `Missing document(s): ${missing.join(', ')}` };
  }
  const months = coverMonths(c);
  const coverEnd = addMonths(c.purchase_date, months);
  if (c.job_date > coverEnd) {
    return {
      queue: 'Out of warranty',
      why: `Job on ${c.job_date} is after cover ended ${coverEnd} (${months}-month cover for ${c.component} on ${c.product.toLowerCase()})`,
    };
  }
  const lateBy = daysBetween(c.job_date, c.claim_date);
  if (lateBy > LATE_DAYS) {
    return { queue: 'Detailed review', why: `Submitted ${lateBy} days after the job; limit ${LATE_DAYS}` };
  }
  const ai = c.ai;
  if (ai.recommendation === 'APPROVE' && ai.confidence >= threshold && c.total_inr <= FAST_LIMIT) {
    return {
      queue: 'Fast lane',
      why: `AI says APPROVE at ${Math.round(ai.confidence * 100)}% (threshold ${threshold.toFixed(2)}) and ${inr(c.total_inr)} is within the ${inr(FAST_LIMIT)} fast-lane limit`,
    };
  }
  const reasons = [];
  if (ai.recommendation !== 'APPROVE') reasons.push(`AI recommendation is ${ai.recommendation}`);
  else if (ai.confidence < threshold) {
    reasons.push(`AI confidence ${Math.round(ai.confidence * 100)}% is below the ${threshold.toFixed(2)} threshold`);
  }
  if (c.total_inr > FAST_LIMIT) reasons.push(`amount ${inr(c.total_inr)} is above the ${inr(FAST_LIMIT)} fast-lane limit`);
  return { queue: 'Detailed review', why: reasons.join('; ') || 'Needs a human look' };
}

function approverFor(total) {
  if (total <= 5000) return 'Warranty executive';
  if (total <= 25000) return 'Desk Lead';
  return 'Head of Customer Service';
}

module.exports = { QUEUES, DEMO_DATE, FAST_LIMIT, LATE_DAYS, addMonths, daysBetween, coverMonths, missingDocs, routeClaim, approverFor, inr };
