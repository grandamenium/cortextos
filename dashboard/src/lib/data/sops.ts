// Fixture-only SOP Library data layer.
//
// This public dashboard build intentionally serves the committed SOP fixture
// corpus only. There is no runtime network, backend proxy, environment, or
// database path in this module.

import {
  isUnmappedRole,
  countGatedSteps,
  countUngatedViolations,
  involvedRoles,
  type SopDocument,
  type SopIndexRow,
  type SopVersionEntry,
} from './sop-model';

// Re-export the pure model so existing server-side imports of `./sops` keep
// working (page.tsx files, sop-board.tsx). Client components must import
// ./sop-model directly rather than relying on this re-export, since pulling
// in this module at all drags node:fs into the import graph.
export * from './sop-model';

export type SopIndexData =
  | {
      state: 'ready';
      baseUrl: string | null;
      source: 'fixtures';
      rows: SopIndexRow[];
      fetchedAt: string;
    }
  | {
      state: 'unconfigured' | 'error';
      baseUrl: string | null;
      reason: string;
      fetchedAt: string;
    };

export type SopDetailData =
  | {
      state: 'ready';
      baseUrl: string | null;
      source: 'fixtures';
      sop: SopDocument;
      version: SopVersionEntry;
      versions: SopVersionEntry[];
      fetchedAt: string;
    }
  | {
      state: 'unconfigured' | 'error';
      baseUrl: string | null;
      reason: string;
      fetchedAt: string;
    };

// ---------------------------------------------------------------------------
// Fixture loading
//
// Statically imported JSON keeps the catalog deterministic at build/test time.
// ---------------------------------------------------------------------------

import sopIndexJson from './__fixtures__/sops/index.json';
import sop_annual_1099 from './__fixtures__/sops/annual-1099.json';
import sop_ap_invoice_processing from './__fixtures__/sops/ap-invoice-processing.json';
import sop_appfolio_renewal_holdover from './__fixtures__/sops/appfolio-renewal-holdover.json';
import sop_appliance_repair_vs_replace from './__fixtures__/sops/appliance-repair-vs-replace.json';
import sop_application_screening_move_in from './__fixtures__/sops/application-screening-move-in.json';
import sop_collections_balance_recovery from './__fixtures__/sops/collections-balance-recovery.json';
import sop_delinquency_escalation_ladder from './__fixtures__/sops/delinquency-escalation-ladder.json';
import sop_emergency_after_hours_maintenance from './__fixtures__/sops/emergency-after-hours-maintenance.json';
import sop_eviction_process from './__fixtures__/sops/eviction-process.json';
import sop_habitability_code_violation_response from './__fixtures__/sops/habitability-code-violation-response.json';
import sop_hoa_coordination from './__fixtures__/sops/hoa-coordination.json';
import sop_insurance_claim from './__fixtures__/sops/insurance-claim.json';
import sop_late_rent_copilot from './__fixtures__/sops/late-rent-copilot.json';
import sop_lease_drafting_execution from './__fixtures__/sops/lease-drafting-execution.json';
import sop_lease_renewal_prefill from './__fixtures__/sops/lease-renewal-prefill.json';
import sop_lease_violation_notice from './__fixtures__/sops/lease-violation-notice.json';
import sop_management_agreement from './__fixtures__/sops/management-agreement.json';
import sop_monthly_owner_statements_qa from './__fixtures__/sops/monthly-owner-statements-qa.json';
import sop_move_in_inspection from './__fixtures__/sops/move-in-inspection.json';
import sop_move_out_deposit_disposition from './__fixtures__/sops/move-out-deposit-disposition.json';
import sop_move_out_inspection from './__fixtures__/sops/move-out-inspection.json';
import sop_nsf_returned_payment_handling from './__fixtures__/sops/nsf-returned-payment-handling.json';
import sop_owner_decision_flow from './__fixtures__/sops/owner-decision-flow.json';
import sop_owner_lead_nurture from './__fixtures__/sops/owner-lead-nurture.json';
import sop_owner_maintenance_approval from './__fixtures__/sops/owner-maintenance-approval.json';
import sop_owner_onboarding from './__fixtures__/sops/owner-onboarding.json';
import sop_owner_status_update from './__fixtures__/sops/owner-status-update.json';
import sop_payment_plan_management from './__fixtures__/sops/payment-plan-management.json';
import sop_periodic_inspection_remediation from './__fixtures__/sops/periodic-inspection-remediation.json';
import sop_pet_and_service_animal from './__fixtures__/sops/pet-and-service-animal.json';
import sop_pm_work_order_closeout from './__fixtures__/sops/pm-work-order-closeout.json';
import sop_property_compliance_readiness from './__fixtures__/sops/property-compliance-readiness.json';
import sop_property_marketing from './__fixtures__/sops/property-marketing.json';
import sop_property_onboarding from './__fixtures__/sops/property-onboarding.json';
import sop_property_sale_support from './__fixtures__/sops/property-sale-support.json';
import sop_recurring_preventive_maintenance from './__fixtures__/sops/recurring-preventive-maintenance.json';
import sop_rent_increase_notice_compliance from './__fixtures__/sops/rent-increase-notice-compliance.json';
import sop_resident_scheduling_cadence from './__fixtures__/sops/resident-scheduling-cadence.json';
import sop_showing_coordination from './__fixtures__/sops/showing-coordination.json';
import sop_trust_accounting_monthly from './__fixtures__/sops/trust-accounting-monthly.json';
import sop_turnover_make_ready from './__fixtures__/sops/turnover-make-ready.json';
import sop_utility_vacancy_flip from './__fixtures__/sops/utility-vacancy-flip.json';
import sop_vendor_coi_verification from './__fixtures__/sops/vendor-coi-verification.json';
import sop_vendor_dispatch_offer_lifecycle from './__fixtures__/sops/vendor-dispatch-offer-lifecycle.json';
import sop_vendor_onboarding from './__fixtures__/sops/vendor-onboarding.json';
import sop_vendor_performance from './__fixtures__/sops/vendor-performance.json';

const FIXTURE_SOPS: Record<string, SopDocument> = {
  'annual-1099': sop_annual_1099 as unknown as SopDocument,
  'ap-invoice-processing': sop_ap_invoice_processing as unknown as SopDocument,
  'appfolio-renewal-holdover': sop_appfolio_renewal_holdover as unknown as SopDocument,
  'appliance-repair-vs-replace': sop_appliance_repair_vs_replace as unknown as SopDocument,
  'application-screening-move-in': sop_application_screening_move_in as unknown as SopDocument,
  'collections-balance-recovery': sop_collections_balance_recovery as unknown as SopDocument,
  'delinquency-escalation-ladder': sop_delinquency_escalation_ladder as unknown as SopDocument,
  'emergency-after-hours-maintenance': sop_emergency_after_hours_maintenance as unknown as SopDocument,
  'eviction-process': sop_eviction_process as unknown as SopDocument,
  'habitability-code-violation-response': sop_habitability_code_violation_response as unknown as SopDocument,
  'hoa-coordination': sop_hoa_coordination as unknown as SopDocument,
  'insurance-claim': sop_insurance_claim as unknown as SopDocument,
  'late-rent-copilot': sop_late_rent_copilot as unknown as SopDocument,
  'lease-drafting-execution': sop_lease_drafting_execution as unknown as SopDocument,
  'lease-renewal-prefill': sop_lease_renewal_prefill as unknown as SopDocument,
  'lease-violation-notice': sop_lease_violation_notice as unknown as SopDocument,
  'management-agreement': sop_management_agreement as unknown as SopDocument,
  'monthly-owner-statements-qa': sop_monthly_owner_statements_qa as unknown as SopDocument,
  'move-in-inspection': sop_move_in_inspection as unknown as SopDocument,
  'move-out-deposit-disposition': sop_move_out_deposit_disposition as unknown as SopDocument,
  'move-out-inspection': sop_move_out_inspection as unknown as SopDocument,
  'nsf-returned-payment-handling': sop_nsf_returned_payment_handling as unknown as SopDocument,
  'owner-decision-flow': sop_owner_decision_flow as unknown as SopDocument,
  'owner-lead-nurture': sop_owner_lead_nurture as unknown as SopDocument,
  'owner-maintenance-approval': sop_owner_maintenance_approval as unknown as SopDocument,
  'owner-onboarding': sop_owner_onboarding as unknown as SopDocument,
  'owner-status-update': sop_owner_status_update as unknown as SopDocument,
  'payment-plan-management': sop_payment_plan_management as unknown as SopDocument,
  'periodic-inspection-remediation': sop_periodic_inspection_remediation as unknown as SopDocument,
  'pet-and-service-animal': sop_pet_and_service_animal as unknown as SopDocument,
  'pm-work-order-closeout': sop_pm_work_order_closeout as unknown as SopDocument,
  'property-compliance-readiness': sop_property_compliance_readiness as unknown as SopDocument,
  'property-marketing': sop_property_marketing as unknown as SopDocument,
  'property-onboarding': sop_property_onboarding as unknown as SopDocument,
  'property-sale-support': sop_property_sale_support as unknown as SopDocument,
  'recurring-preventive-maintenance': sop_recurring_preventive_maintenance as unknown as SopDocument,
  'rent-increase-notice-compliance': sop_rent_increase_notice_compliance as unknown as SopDocument,
  'resident-scheduling-cadence': sop_resident_scheduling_cadence as unknown as SopDocument,
  'showing-coordination': sop_showing_coordination as unknown as SopDocument,
  'trust-accounting-monthly': sop_trust_accounting_monthly as unknown as SopDocument,
  'turnover-make-ready': sop_turnover_make_ready as unknown as SopDocument,
  'utility-vacancy-flip': sop_utility_vacancy_flip as unknown as SopDocument,
  'vendor-coi-verification': sop_vendor_coi_verification as unknown as SopDocument,
  'vendor-dispatch-offer-lifecycle': sop_vendor_dispatch_offer_lifecycle as unknown as SopDocument,
  'vendor-onboarding': sop_vendor_onboarding as unknown as SopDocument,
  'vendor-performance': sop_vendor_performance as unknown as SopDocument,
};

interface FixtureIndexEntry {
  slug: string;
  name: string;
  subject_type: string;
  stage_count: number;
  task_count: number;
  drift_detected?: boolean;
}

interface FixtureIndex {
  captured_at: string;
  templates: FixtureIndexEntry[];
}

function readFixtureIndex(): FixtureIndex {
  return sopIndexJson as unknown as FixtureIndex;
}

function readFixtureSop(slug: string): SopDocument {
  const source = FIXTURE_SOPS[slug];
  if (!source) {
    throw new Error(`No fixture registered for SOP slug "${slug}".`);
  }
  // Deep-clone so callers can safely normalize/mutate without corrupting the
  // shared imported module (JSON imports are effectively frozen singletons).
  const doc = JSON.parse(JSON.stringify(source)) as SopDocument;
  // Normalize: fixtures omit depends_on on steps with no dependencies.
  for (const stage of doc.stages) {
    for (const step of stage.steps) {
      step.depends_on = step.depends_on ?? [];
    }
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

function buildIndexRowFromFixture(entry: FixtureIndexEntry): SopIndexRow {
  const sop = readFixtureSop(entry.slug);
  const roles = involvedRoles(sop);
  return {
    slug: sop.slug,
    name: sop.name,
    description: sop.description,
    subject_type: sop.subject_type,
    stage_count: sop.stages.length,
    task_count: sop.stages.reduce((n, s) => n + s.steps.length, 0),
    gated_step_count: countGatedSteps(sop),
    ungated_violation_count: countUngatedViolations(sop),
    drift_detected: entry.drift_detected ?? false,
    involved_roles: roles,
    has_unmapped_role: roles.some(isUnmappedRole),
    is_synthetic_demo: sop.slug.startsWith('demo-'),
  };
}

export async function getSopIndex(): Promise<SopIndexData> {
  const fetchedAt = new Date().toISOString();

  try {
    const index = readFixtureIndex();
    const rows = index.templates.map(buildIndexRowFromFixture);
    return { state: 'ready', baseUrl: null, source: 'fixtures', rows, fetchedAt };
  } catch (error) {
    return {
      state: 'error',
      baseUrl: null,
      reason: error instanceof Error ? error.message : String(error),
      fetchedAt,
    };
  }
}

/**
 * Read-only version history derived from the fixture capture timestamp.
 */
function fixtureVersion(sop: SopDocument): SopVersionEntry {
  return {
    id: 'v0',
    updated_at: sop.captured_at,
    updated_by: 'system',
    change_note: 'Initial corpus capture.',
  };
}

export async function getSop(slug: string): Promise<SopDetailData> {
  const fetchedAt = new Date().toISOString();

  try {
    const index = readFixtureIndex();
    const exists = index.templates.some((t) => t.slug === slug);
    if (!exists) {
      return {
        state: 'error',
        baseUrl: null,
        reason: `SOP "${slug}" was not found in the library.`,
        fetchedAt,
      };
    }
    const sop = readFixtureSop(slug);
    const version = fixtureVersion(sop);
    return {
      state: 'ready',
      baseUrl: null,
      source: 'fixtures',
      sop,
      version,
      versions: [version],
      fetchedAt,
    };
  } catch (error) {
    return {
      state: 'error',
      baseUrl: null,
      reason: error instanceof Error ? error.message : String(error),
      fetchedAt,
    };
  }
}
