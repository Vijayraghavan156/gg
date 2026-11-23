'use strict';

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
const firstLine = text => String(text || '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
const clip = (text, max = 140) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}...` : text);

function statusLine({ assessment: a, thirdParty = {}, qp = null, rd = null, dp = null, viewer = {}, base, tierLabel = t => t, day = d => String(d || '') }) {
  const step = (key, anchor) => `${base}?step=${key}${anchor ? `#${anchor}` : ''}`;
  const out = (key, text, tone, action = null) => ({ key, text, tone, action: action ? { ...action, step: (/[?&]step=([a-z]+)/.exec(action.href) || [])[1] || null } : null });
  const tier = a.final_tier ? tierLabel(a.final_tier) : null;
  const qq = qp && qp.questionnaire ? qp.questionnaire : null;
  const rv = qp && qp.review ? qp.review : null;
  const open = rd && rd.open ? rd.open : null;
  const issued = rd && rd.issued ? rd.issued : null;
  const tp = thirdParty.name || 'the third party';

  switch (a.status) {
    case 'scoping':
      if (a.return_comment) {
        return out('scope_returned', `Sent back by ${a.returned_by_name || 'the reviewer'}${a.returned_at ? ` on ${day(a.returned_at)}` : ''}: ${clip(firstLine(a.return_comment))}`,
          'attention', viewer.canManage ? { label: 'Change the scope', href: step('scope') } : null);
      }
      return out('scoping', 'Answer the criticality questions and propose a tier.', 'quiet',
        viewer.canManage ? { label: 'Continue the scope', href: step('scope') } : null);
    case 'tier_proposed': {
      const mayConfirm = viewer.canReview && (!viewer.isProposer || (viewer.isManager && viewer.selfApproveTiers));
      return out('tier_proposed', `Tier ${tier} proposed${a.proposed_by_name ? ` by ${a.proposed_by_name}` : ''}, waiting for a second person to confirm it.`,
        'attention', mayConfirm ? { label: 'Confirm the tier', href: step('scope') } : null);
    }
    case 'tier_confirmed': {
      if (!qq) {
        return out('questionnaire_none', `Tier ${tier} confirmed. The questionnaire is not prepared yet.`, 'quiet',
          viewer.canManage && qp && qp.canPrepare ? { label: 'Prepare the questionnaire', href: step('questionnaire') } : null);
      }
      if (qq.status === 'draft') {
        return out('questionnaire_draft', 'The questionnaire is prepared and not sent yet.', 'quiet',
          viewer.canManage ? { label: 'Send it to the third party', href: step('questionnaire') } : null);
      }
      if (['sent', 'in_progress'].includes(qq.status)) {
        const link = qp.activeLink;
        const who = link && link.recipient_name ? `${link.recipient_name} at ${tp}` : tp;
        const progress = rv ? ` ${rv.answered} of ${plural(rv.total, 'question')} answered.` : '';
        const expires = link && link.expires_at ? ` The link stops working on ${day(link.expires_at)}.` : ' No link is active.';
        return out('with_third_party', `Waiting on ${who}${qq.sent_at ? ` since ${day(qq.sent_at)}` : ''}.${progress}${expires}`, 'attention',
          !link && viewer.canManage ? { label: 'Issue a new link', href: step('questionnaire', 'questionnaire') } : null);
      }
      if (['submitted', 'under_review'].includes(qq.status)) {
        const b = (rv && rv.blockers) || {};
        const parts = [];
        if (b.unreviewed) parts.push(`${plural(b.unreviewed, 'answer')} without a conclusion`);
        if (b.unchecked) parts.push(`${plural(b.unchecked, 'certificate or report', 'certificates or reports')} to check`);
        const waiting = rv && rv.openClarifications ? ` Waiting on ${tp} for ${plural(rv.openClarifications, 'clarification')}.` : '';
        if (!parts.length) {
          return out('review_ready', `Every answer has a conclusion.${waiting || ' The review can be closed.'}`, waiting ? 'attention' : 'quiet',
            viewer.canManage && !waiting ? { label: 'Close the review', href: step('review', 'questionnaire-answers') } : null);
        }
        return out('review', `${parts.join(', ')}.${waiting}`.replace(/^./, c => c.toUpperCase()), 'quiet',
          viewer.canManage ? { label: 'Review the answers', href: step('review', 'questionnaire-answers') } : null);
      }
      if (open) return recommendationLine();
      return out('recommendation_none', `${qq.not_returned ? 'The questionnaire was not returned.' : 'The answers are reviewed.'} The recommendation is next.`, 'quiet',
        rd && rd.canCreate ? { label: 'Draft the recommendation', href: step('recommendation', 'recommendation') } : null);
    }
    case 'recommendation_draft':
      return recommendationLine();
    case 'recommendation_in_review':
      return out('recommendation_in_review', `Recommendation version ${open ? open.version : ''} is waiting for a second person to review it${open && open.submitted_at ? ` since ${day(open.submitted_at)}` : ''}.`.replace(' version  is', ' is'),
        'attention', rd && rd.canReviewOpen ? { label: 'Review the recommendation', href: step('recommendation', 'recommendation') } : null);
    case 'recommendation_issued':
      return out('with_client', `Recommendation issued${issued && issued.issued_at ? ` on ${day(issued.issued_at)}` : ''}. Waiting on ${a.client_decision_owner_name || 'the client decision owner'} to record the client's decision.`, 'attention', null);
    case 'information_requested': {
      const asked = dp && dp.informationRequest ? dp.informationRequest : null;
      return out('information_requested', `${asked && asked.decided_by_name ? asked.decided_by_name : 'The client'} asked for more information${asked && asked.decided_at ? ` on ${day(asked.decided_at)}` : ''}${asked && asked.rationale ? `: ${clip(firstLine(asked.rationale))}` : '.'}`,
        'attention', dp && dp.canStartRevision ? { label: 'Start a revised recommendation', href: step('decision') } : null);
    }
    case 'completed': {
      const d = dp && dp.decisions && dp.decisions[0] ? dp.decisions[0] : null;
      return out('completed', `Completed${d && d.decided_at ? ` on ${day(d.decided_at)}` : ''}${d && dp.labels ? `: ${dp.labels[d.outcome] || d.outcome}` : ''}.`, 'good', null);
    }
    case 'cancelled':
      return out('cancelled', `Cancelled${a.cancelled_at ? ` on ${day(a.cancelled_at)}` : ''}${a.cancel_reason ? `: ${clip(firstLine(a.cancel_reason))}` : '.'}`, 'quiet', null);
    default:
      return out(a.status || 'unknown', '', 'quiet', null);
  }

  function recommendationLine() {
    if (open && open.status === 'changes_requested') {
      return out('recommendation_changes', `Changes requested on recommendation version ${open.version}${open.reviewer_name ? ` by ${open.reviewer_name}` : ''}${open.review_comment ? `: ${clip(firstLine(open.review_comment))}` : '.'}`,
        'attention', rd.canEdit ? { label: 'Change the recommendation', href: step('recommendation', 'recommendation') } : null);
    }
    if (open) {
      return out('recommendation_draft', `Recommendation version ${open.version} is being drafted${open.author_name ? ` by ${open.author_name}` : ''}.`, 'quiet',
        rd.canEdit ? { label: 'Continue the recommendation', href: step('recommendation', 'recommendation') } : null);
    }
    return out('recommendation_none', 'The recommendation is next.', 'quiet',
      rd && rd.canCreate ? { label: 'Draft the recommendation', href: step('recommendation', 'recommendation') } : null);
  }
}

module.exports = { statusLine };
