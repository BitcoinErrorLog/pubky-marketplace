'use client';

import { useCallback, useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';
import type {
  InventoryImportDryRunCounts,
  InventoryImportScene,
} from '@/organisms/Marketplace/MarketplaceInventoryImport';

export function useMarketplaceInventoryImport(sellerPubky: string | null) {
  const [scene, setScene] = useState<InventoryImportScene>('upload');
  const [step, setStep] = useState(1);
  const [fileName, setFileName] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const [counts, setCounts] = useState<InventoryImportDryRunCounts | undefined>();
  const [manifestId, setManifestId] = useState<string | null>(null);
  const [conflictListingId, setConflictListingId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | undefined>();
  const [busy, setBusy] = useState(false);

  const reset = useCallback(() => {
    setScene('upload');
    setStep(1);
    setFileName(undefined);
    setMessage(undefined);
    setCounts(undefined);
    setManifestId(null);
    setConflictListingId(null);
    setProgress(undefined);
    setBusy(false);
  }, []);

  const planFile = useCallback(
    async (file: File) => {
      if (!sellerPubky) return;
      setBusy(true);
      setFileName(file.name);
      setScene('validation');
      setStep(2);
      const result = await CommerceController.planInventoryImport(sellerPubky, file);
      setBusy(false);
      if (result.status === 'parse-failed') {
        setScene(result.message.startsWith('This file exceeds') ? 'limit' : 'parse-fail');
        setMessage(result.message);
        return;
      }
      if (result.status !== 'planned') {
        setScene('parse-fail');
        setMessage('This file could not be planned. Nothing was published.');
        return;
      }
      setManifestId(result.manifestId);
      setCounts(result.counts);
      setConflictListingId(null);
      setScene(result.counts.conflict > 0 ? 'conflict' : 'dry-run');
      setStep(result.counts.conflict > 0 ? 5 : 4);
    },
    [sellerPubky],
  );

  const applyPublishResult = useCallback(
    (result: Awaited<ReturnType<typeof CommerceController.publishInventoryImport>>) => {
      if (result.status === 'conflict') {
        setScene('conflict');
        setConflictListingId(result.listingId);
        setMessage(result.message);
        return;
      }
      if (result.status === 'rate-limited') {
        setScene('mixed');
        setMessage(result.message);
        return;
      }
      if (result.status === 'complete') {
        setProgress({ done: result.synced + result.failed, total: result.synced + result.failed });
        setScene(result.mixed ? 'mixed' : 'result');
        setStep(6);
        setMessage(result.message);
        setConflictListingId(null);
        return;
      }
      setScene('parse-fail');
      setMessage(result.status === 'error' ? result.message : 'This file could not be planned. Nothing was published.');
    },
    [],
  );

  const publish = useCallback(async () => {
    if (!sellerPubky || !manifestId) return;
    setBusy(true);
    setScene('progress');
    setStep(5);
    setProgress({ done: 0, total: counts ? counts.create + counts.update + counts.end : 0 });
    const result = await CommerceController.publishInventoryImport(sellerPubky, manifestId);
    setBusy(false);
    applyPublishResult(result);
  }, [applyPublishResult, counts, manifestId, sellerPubky]);

  const resume = useCallback(async () => {
    if (!sellerPubky || !manifestId) return;
    setBusy(true);
    setScene('progress');
    const result = await CommerceController.resumeInventoryImport(sellerPubky, manifestId);
    setBusy(false);
    applyPublishResult(result);
  }, [applyPublishResult, manifestId, sellerPubky]);

  const confirmConflict = useCallback(async () => {
    if (!sellerPubky || !manifestId) return;
    setBusy(true);
    const result = await CommerceController.confirmInventoryImportConflict(
      sellerPubky,
      manifestId,
      conflictListingId ?? '',
    );
    setBusy(false);
    if (result.status === 'planned') {
      setCounts(result.counts);
      setConflictListingId(null);
      setScene(result.counts.conflict > 0 ? 'conflict' : 'dry-run');
      setStep(result.counts.conflict > 0 ? 5 : 4);
      return;
    }
    applyPublishResult(result);
  }, [applyPublishResult, conflictListingId, manifestId, sellerPubky]);

  const discardConflict = useCallback(async () => {
    if (!sellerPubky || !manifestId) return;
    setBusy(true);
    const result = await CommerceController.discardInventoryImportConflict(
      sellerPubky,
      manifestId,
      conflictListingId ?? '',
    );
    setBusy(false);
    if (result.status === 'planned') {
      setCounts(result.counts);
      setConflictListingId(null);
      setScene(result.counts.conflict > 0 ? 'conflict' : 'dry-run');
      setStep(result.counts.conflict > 0 ? 5 : 4);
      return;
    }
    applyPublishResult(result);
  }, [applyPublishResult, conflictListingId, manifestId, sellerPubky]);

  const downloadResult = useCallback(async () => {
    if (!sellerPubky || !manifestId) return;
    const csv = await CommerceController.inventoryImportResultCsv(sellerPubky, manifestId);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'inventory-import-result.csv';
    link.click();
    URL.revokeObjectURL(url);
  }, [manifestId, sellerPubky]);

  const exportListings = useCallback(async () => {
    if (!sellerPubky) return;
    const bytes = await CommerceController.exportInventoryListingsCsv(sellerPubky);
    const blob = new Blob([new Uint8Array(bytes)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'listings.csv';
    link.click();
    URL.revokeObjectURL(url);
  }, [sellerPubky]);

  const exportOrders = useCallback(async () => {
    if (!sellerPubky) return;
    const json = await CommerceController.exportInventoryOrdersJson(sellerPubky);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'orders.json';
    link.click();
    URL.revokeObjectURL(url);
  }, [sellerPubky]);

  return {
    scene,
    step,
    fileName,
    message,
    counts,
    progress,
    busy,
    reset,
    planFile,
    publish,
    resume,
    confirmConflict,
    discardConflict,
    downloadResult,
    exportListings,
    exportOrders,
  };
}
