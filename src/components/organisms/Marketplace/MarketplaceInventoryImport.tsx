'use client';

import { Button } from '@/atoms/Button/Button';
import { Input } from '@/atoms/Input/Input';
import { Typography } from '@/atoms/Typography/Typography';
import { ProgressSteps } from '@/molecules/ProgressSteps/ProgressSteps';

export const IMPORT_WIZARD_STEPS = 6;

export type InventoryImportScene =
  | 'upload'
  | 'validation'
  | 'map'
  | 'dry-run'
  | 'progress'
  | 'result'
  | 'parse-fail'
  | 'limit'
  | 'conflict'
  | 'mixed';

export type InventoryImportDryRunCounts = {
  create: number;
  update: number;
  end: number;
  unchanged: number;
  conflict: number;
};

export type MarketplaceInventoryImportProps = {
  step: number;
  scene: InventoryImportScene;
  fileName?: string;
  message?: string;
  counts?: InventoryImportDryRunCounts;
  progress?: { done: number; total: number };
  mappingHeaders?: readonly string[];
  onFile?: (file: File) => void;
  onPublish?: () => void;
  onResume?: () => void;
  onConfirmConflict?: () => void;
  onDiscardConflict?: () => void;
  onDownloadResult?: () => void;
  onExportListings?: () => void;
  onExportOrders?: () => void;
};

const SCENE_STEP: Record<InventoryImportScene, number> = {
  upload: 1,
  validation: 2,
  map: 3,
  'dry-run': 4,
  progress: 5,
  result: 6,
  'parse-fail': 2,
  limit: 2,
  conflict: 5,
  mixed: 6,
};

export function MarketplaceInventoryImport({
  step,
  scene,
  fileName,
  message,
  counts,
  progress,
  mappingHeaders = [],
  onFile,
  onPublish,
  onResume,
  onConfirmConflict,
  onDiscardConflict,
  onDownloadResult,
  onExportListings,
  onExportOrders,
}: MarketplaceInventoryImportProps) {
  const currentStep = step || SCENE_STEP[scene];

  return (
    <div className="flex flex-col gap-4" data-surface="inventory-studio" data-testid="inventory-import">
      <ProgressSteps currentStep={currentStep} totalSteps={IMPORT_WIZARD_STEPS} />
      {scene === 'upload' && (
        <>
          <Typography as="p" className="text-sm text-muted-foreground">
            Upload a canonical CSV or JSON listing file. Nothing is published until you confirm the dry-run.
          </Typography>
          <Input
            type="file"
            accept=".csv,.json,text/csv,application/json"
            aria-label="Import file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onFile?.(file);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" className="rounded-full" onClick={onExportListings}>
              Export listings CSV
            </Button>
            <Button variant="secondary" className="rounded-full" onClick={onExportOrders}>
              Export orders JSON
            </Button>
          </div>
        </>
      )}
      {scene === 'validation' && (
        <Typography as="p" className="text-sm text-muted-foreground">
          {fileName ? `Validating ${fileName}.` : 'Validating the file.'}
        </Typography>
      )}
      {scene === 'map' && (
        <>
          <Typography as="p" className="text-sm text-muted-foreground">
            Canonical columns mapped automatically. Non-canonical headers stay unmapped until a later importer rewrite.
          </Typography>
          {mappingHeaders.length > 0 && (
            <ul className="list-inside list-disc text-sm text-muted-foreground">
              {mappingHeaders.map((header) => (
                <li key={header}>{header}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {scene === 'dry-run' && counts && (
        <>
          <Typography as="p" className="text-sm text-muted-foreground">
            Dry-run for {fileName ?? 'this file'}. Nothing has been published.
          </Typography>
          <ul className="grid grid-cols-2 gap-2 text-sm" data-testid="inventory-import-dry-run">
            <li>Create {counts.create}</li>
            <li>Update {counts.update}</li>
            <li>End {counts.end}</li>
            <li>Unchanged {counts.unchanged}</li>
            <li>Conflict {counts.conflict}</li>
          </ul>
          <Button className="rounded-full" onClick={onPublish}>
            Publish
          </Button>
        </>
      )}
      {scene === 'progress' && (
        <Typography as="p" className="text-sm text-muted-foreground" data-testid="inventory-import-progress">
          Saving your listings… {progress?.done ?? 0} of {progress?.total ?? 0}.
        </Typography>
      )}
      {scene === 'result' && (
        <>
          <Typography as="p" className="text-sm text-muted-foreground">
            {message ?? 'Import finished.'}
          </Typography>
          <Button className="rounded-full" onClick={onDownloadResult}>
            Download result
          </Button>
        </>
      )}
      {scene === 'parse-fail' && (
        <Typography as="p" className="text-sm text-muted-foreground" role="alert">
          {message ?? 'This file could not be planned. Nothing was published.'}
        </Typography>
      )}
      {scene === 'limit' && (
        <Typography as="p" className="text-sm text-muted-foreground" role="alert">
          {message ?? 'This file exceeds the import limit.'}
        </Typography>
      )}
      {scene === 'conflict' && (
        <>
          <Typography as="p" className="text-sm text-muted-foreground" role="status">
            {message ?? 'This listing changed since the plan. Confirm or discard; it will not be overwritten.'}
          </Typography>
          <div className="flex flex-wrap gap-2">
            <Button className="rounded-full" onClick={onConfirmConflict}>
              Confirm
            </Button>
            <Button variant="secondary" className="rounded-full" onClick={onDiscardConflict}>
              Discard
            </Button>
            <Button variant="ghost" className="rounded-full" onClick={onResume}>
              Resume unfinished
            </Button>
          </div>
        </>
      )}
      {scene === 'mixed' && (
        <>
          <Typography as="p" className="text-sm text-muted-foreground" role="status">
            {message ?? 'Some listings synced; some did not. Resume publishes only the unfinished rows.'}
          </Typography>
          <div className="flex flex-wrap gap-2">
            <Button className="rounded-full" onClick={onResume}>
              Resume
            </Button>
            <Button variant="secondary" className="rounded-full" onClick={onDownloadResult}>
              Download result
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
