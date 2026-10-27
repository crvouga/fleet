import { PageHeader } from '../layout';

export function NotFoundBody(props: {
  what: string;
  href: string;
  link: string;
}) {
  return (
    <div>
      <PageHeader title={`${props.what} not found`} />
      <div class="card card-pad">
        <p class="text-fg-2">
          It may have been deleted, or the address is wrong.
        </p>
        <a class="btn mt-4" href={props.href}>
          {props.link}
        </a>
      </div>
    </div>
  );
}
