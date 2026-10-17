import { useCallback, useRef } from 'react';
import type { DockviewApi } from 'dockview-react';
import { toast } from 'sonner';
import { hasActiveHistoryOverlay, isNativeHistoryOwner } from '@plannotator/ui/utils/undoHistory';
import { REVIEW_CODE_NAV_PANEL_ID, REVIEW_PANEL_TYPES } from '../dock/reviewPanelTypes';
import { useReviewEditorShortcuts } from '../shortcuts';
import { useCodeNav, type CodeNavRequest } from './useCodeNav';

interface Options {
  dockApi: DockviewApi | null;
  snapshotId?: string;
  sourcePanelId: string;
  localCheckoutAvailable: boolean;
  guideOpen: boolean;
  closeTokenHover(): void;
}

/** Owns the References dock lifecycle; lookup and visit history stay in useCodeNav. */
export function useReferencePanel({
  dockApi, snapshotId, sourcePanelId, localCheckoutAvailable, guideOpen, closeTokenHover,
}: Options) {
  const codeNav = useCodeNav(snapshotId);
  const origin = useRef<{ panelId: string; width?: number } | null>(null);

  const showReferences = useCallback((symbol: string | null, annotationId?: string) => {
    if (!dockApi) return;
    const existing = dockApi.getPanel(REVIEW_CODE_NAV_PANEL_ID);
    if (existing) {
      existing.api.updateParameters({ annotationId });
      if (!annotationId) existing.api.setTitle(symbol ? `References: ${symbol}` : 'References');
      existing.api.setActive();
    } else {
      dockApi.addPanel({
        id: REVIEW_CODE_NAV_PANEL_ID,
        component: REVIEW_PANEL_TYPES.CODE_NAV,
        title: symbol ? `References: ${symbol}` : 'References',
        params: { annotationId },
        position: {
          direction: 'right',
          referencePanel: dockApi.getPanel(origin.current?.panelId ?? '')?.id ?? sourcePanelId,
        },
        // Size only on creation so nested jumps preserve the reviewer's layout.
        initialWidth: origin.current?.width ?? Math.round(dockApi.width * 0.7),
      });
    }
  }, [dockApi, sourcePanelId]);

  const handleCodeNavRequest = useCallback((request: CodeNavRequest) => {
    // Cancel pending hover dwell as well as its card before opening References.
    closeTokenHover();
    if (!localCheckoutAvailable) {
      toast('Code navigation requires a local checkout', {
        description: 'Re-run with --local for PR reviews',
        duration: 4000,
      });
      return;
    }
    if (!dockApi?.getPanel(REVIEW_CODE_NAV_PANEL_ID) && dockApi?.activePanel) {
      origin.current = { panelId: dockApi.activePanel.id };
    }
    void codeNav.resolve(request);
    showReferences(request.symbol);
  }, [closeTokenHover, localCheckoutAvailable, dockApi, codeNav.resolve, showReferences]);

  const canUseDockShortcut = (event: KeyboardEvent) => !event.defaultPrevented && !event.repeat
    && !isNativeHistoryOwner(event) && !hasActiveHistoryOverlay(document) && !guideOpen;
  const canNavigateReferences = (event: KeyboardEvent) => canUseDockShortcut(event)
    && (!!dockApi?.getPanel(REVIEW_CODE_NAV_PANEL_ID)
      || (codeNav.isAtSource && codeNav.canGoForward && !!origin.current));
  const navigateReferences = (direction: -1 | 1) => {
    closeTokenHover();
    const panel = dockApi?.getPanel(REVIEW_CODE_NAV_PANEL_ID);
    if (direction === -1 && (codeNav.backReturnsToSource || codeNav.isAtSource)) {
      if (panel && origin.current) origin.current.width = panel.api.width;
      panel?.api.close();
      dockApi?.getPanel(origin.current?.panelId ?? '')?.api.setActive();
    } else {
      showReferences(codeNav.activeSymbol);
    }
    codeNav.go(direction);
  };

  useReviewEditorShortcuts({
    handlers: {
      referenceBack: {
        when: canNavigateReferences,
        handle: () => { if (codeNav.canGoBack || codeNav.isAtSource) navigateReferences(-1); },
      },
      referenceForward: {
        when: canNavigateReferences,
        handle: () => { if (codeNav.canGoForward) navigateReferences(1); },
      },
      closeTab: {
        when: event => canUseDockShortcut(event) && !!dockApi?.activePanel,
        handle: () => dockApi?.activePanel?.api.close(),
      },
    },
  });

  return { codeNav, showReferences, handleCodeNavRequest };
}
