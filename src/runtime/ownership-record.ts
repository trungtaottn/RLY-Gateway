import { z } from "zod";

export const processIdentitySchema = z.object({
  pid: z.number().int().positive(),
  processStartedAt: z.iso.datetime(),
});

export const ownershipRecordSchema = z.object({
  ...processIdentitySchema.shape,
  instanceId: z.uuid(),
  port: z.number().int().min(1024).max(65535),
  executableFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  configFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  nonceHash: z.string().regex(/^[a-f0-9]{64}$/),
  ownerLauncherPid: z.number().int().positive(),
  leases: z.array(z.uuid()),
});

export type OwnershipRecord = z.infer<typeof ownershipRecordSchema>;

export type ProcessIdentity = Readonly<Pick<OwnershipRecord, "pid" | "processStartedAt">>;

export type OwnershipExpectation = Readonly<Pick<
  OwnershipRecord,
  "pid" | "processStartedAt" | "instanceId" | "port" | "executableFingerprint" | "configFingerprint"
>>;

export const ownershipExpectationSchema = ownershipRecordSchema.pick({
  pid: true,
  processStartedAt: true,
  instanceId: true,
  port: true,
  executableFingerprint: true,
  configFingerprint: true,
});

/**
 * A PID alone is not an ownership proof: operating systems can reuse it after
 * a process exits. Callers must compare the process creation identity too.
 */
export function matchesProcessIdentity(
  record: Pick<OwnershipRecord, "pid" | "processStartedAt">,
  observed: ProcessIdentity | undefined,
): boolean {
  return observed !== undefined
    && record.pid === observed.pid
    && record.processStartedAt === observed.processStartedAt;
}

export function canReuseInstance(
  record: OwnershipRecord,
  expected: OwnershipExpectation,
): boolean {
  return record.pid === expected.pid
    && record.processStartedAt === expected.processStartedAt
    && record.instanceId === expected.instanceId
    && record.port === expected.port
    && record.executableFingerprint === expected.executableFingerprint
    && record.configFingerprint === expected.configFingerprint;
}
