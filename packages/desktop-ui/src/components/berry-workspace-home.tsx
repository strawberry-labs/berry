import type { ReactNode } from "react";

export function BerryWorkspaceHomeFrame({ logo, greeting, composer, help, error, footer }: {
  logo: ReactNode;
  greeting: ReactNode;
  composer: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="berry-home-stage relative flex h-full flex-col overflow-hidden">
      {help ? <div className="absolute right-4 top-[calc(var(--berry-titlebar-height)/2)] z-10 -translate-y-1/2">{help}</div> : null}
      <div className="berry-home-center flex flex-1 flex-col items-center justify-center px-8">
        <div className="pointer-events-none z-10 flex select-none items-center justify-center text-center">
          <div className="berry-home-title flex items-center justify-center">
            {logo}
            <h1 className="berry-home-greeting text-balance">{greeting}</h1>
          </div>
        </div>
        <div className="berry-home-composer-wrap z-10 max-w-full">
          {composer}
          {error}
        </div>
        {footer ? <div className="berry-home-footer z-10 mt-4 w-full max-w-[768px]">{footer}</div> : null}
      </div>
    </div>
  );
}
