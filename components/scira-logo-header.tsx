import React from 'react';
import { RovoLogo } from './logos/scira-logo';

export const RovoLogoHeader = () => (
  <div className="flex items-center gap-2 my-1.5">
    <RovoLogo className="size-6.5" />
    <h2 className="text-xl font-normal font-be-vietnam-pro text-foreground dark:text-foreground">Rovo</h2>
  </div>
);
