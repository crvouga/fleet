import { ACTIVE_ROLES } from '../../types';
import { cx } from '../lib/tw';

/**
 * Approve, optionally assigning a role in the same step. A plain POST form;
 * "No role yet" approves the machine into the role-less base system.
 */
export function ApproveForm(props: {
  nodeId: string;
  label: string;
  next?: string;
  class?: string;
}) {
  const field = `approve-role-${props.nodeId.slice(0, 12)}`;
  return (
    <form
      method="post"
      action={`/nodes/${props.nodeId}/approve`}
      class={cx('inline-flex flex-wrap items-center gap-2', props.class)}
    >
      {props.next === undefined ? null : (
        <input type="hidden" name="next" value={props.next} />
      )}
      <label class="sr-only" for={field}>
        Role to assign on approval
      </label>
      <select id={field} name="role" class="field w-auto pr-8">
        <option value="" selected>
          No role yet
        </option>
        {ACTIVE_ROLES.map((role) => (
          <option key={role} value={role}>
            {`Assign ${role}`}
          </option>
        ))}
      </select>
      <button type="submit" class="btn btn-primary">
        {props.label}
      </button>
    </form>
  );
}
