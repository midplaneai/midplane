// The deploy templates in deploy/, against the gateway they run: each pins
// the image of this package's version, so the commit that bumps the version
// bumps them too, and the release publishes them as they are. And what
// each must keep: nothing that connects in, the gateway's folder on a disk
// of its own, one instance, and no secret in the template itself.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const root = join(import.meta.dirname, "..", "..", "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const { version } = JSON.parse(read("apps/gateway/package.json"));
const image = `ghcr.io/midplaneai/midplane:${version}`;
const DATA = "/var/lib/midplane";

/** A template's YAML; CloudFormation's short tags (`!Ref`) read as their plain values. */
const yaml = (file: string) => parseYaml(read(file), { logLevel: "error" });

describe("AWS CloudFormation", () => {
  const t = yaml("deploy/aws/midplane-gateway.yaml");
  const resources = t.Resources as Record<
    string,
    { Type: string; Properties: Record<string, unknown> }
  >;
  const userData = resources.Instance?.Properties.UserData as {
    "Fn::Base64": [string, object];
  };
  const [script, values] = userData["Fn::Base64"];

  it("runs this version's image", () => {
    expect(values).toEqual({ Image: image });
    expect(t.Outputs.Version.Value).toBe(version);
    expect(t.Description).toContain(`(${version})`);
  });

  it("lets nothing in", () => {
    const groups = Object.values(resources).filter(
      (r) => r.Type === "AWS::EC2::SecurityGroup",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.Properties).not.toHaveProperty("SecurityGroupIngress");
    // The one ingress rule is into the database's group, from the gateway's.
    const ingress = Object.values(resources).filter(
      (r) => r.Type === "AWS::EC2::SecurityGroupIngress",
    );
    expect(ingress.map((r) => r.Properties.GroupId)).toEqual([
      "DatabaseSecurityGroupId",
    ]);
    expect(script).not.toMatch(/ -p /);
  });

  it("asks for no secret, and keeps the env file in the secret it reads", () => {
    for (const p of Object.values(t.Parameters) as { NoEcho?: boolean }[]) {
      expect(p.NoEcho).toBeUndefined();
    }
    expect(script).not.toContain("MIDPLANE_ENROLLMENT_TOKEN");
    expect(script).toContain("--env-file /run/midplane/midplane.env");
    const role = resources.Role?.Properties.Policies as {
      PolicyDocument: { Statement: { Action: unknown; Resource: unknown }[] };
    }[];
    const reads = role
      .flatMap((p) => p.PolicyDocument.Statement)
      .filter((s) => s.Action === "secretsmanager:GetSecretValue");
    expect(reads).toEqual([expect.objectContaining({ Resource: "EnvFile" })]);
  });

  it("keeps the gateway's folder on an encrypted disk that updates don't replace", () => {
    const instance = resources.Instance?.Properties ?? {};
    expect(script).toContain(`-v midplane:${DATA}`);
    const disks = instance.BlockDeviceMappings as {
      Ebs: { Encrypted: boolean };
    }[];
    expect(disks.map((d) => d.Ebs.Encrypted)).toEqual([true]);
    // EC2 resolves the image, so the template's value never changes; a
    // value CloudFormation resolves, or a launch template, would replace
    // the instance on an update.
    expect(instance.ImageId).toMatch(/^resolve:ssm:\/aws\/service\//);
    expect(instance).not.toHaveProperty("LaunchTemplate");
    // And the secret has no value here for an update to write.
    expect(resources.EnvFile?.Properties).not.toHaveProperty("SecretString");
  });

  it("keeps the instance's role out of the container's reach", () => {
    expect(resources.Instance?.Properties.MetadataOptions).toEqual({
      HttpTokens: "required",
      HttpPutResponseHopLimit: 1,
    });
  });
});

describe("Render", () => {
  const t = yaml("deploy/render/render.yaml");

  it("is one worker, with this version's image and the gateway's folder on its disk", () => {
    expect(t.services).toHaveLength(1);
    const [s] = t.services;
    expect(s).toMatchObject({
      type: "worker",
      runtime: "image",
      image: { url: image },
      numInstances: 1,
      disk: { mountPath: DATA },
    });
    // The env file is added in Render, never here.
    expect(s.envVars).toBeUndefined();
  });
});

describe("Helm", () => {
  const dir = "deploy/helm/midplane-gateway";
  const chart = yaml(`${dir}/Chart.yaml`);
  const templates = readdirSync(join(root, dir, "templates")).map((f) =>
    read(`${dir}/templates/${f}`),
  );

  it("is this version, and runs its image", () => {
    expect(chart.version).toBe(version);
    expect(chart.appVersion).toBe(version);
    expect(yaml(`${dir}/values.yaml`).image).toMatchObject({
      repository: "ghcr.io/midplaneai/midplane",
      tag: "",
    });
  });

  it("is one pod on its own disk, with no Service or Ingress", () => {
    const all = templates.join("\n");
    expect(all.match(/^kind: (\w+)/gm)).toEqual(["kind: StatefulSet"]);
    expect(all).toContain("replicas: 1");
    expect(all).toContain(`mountPath: ${DATA}`);
    expect(all).not.toMatch(/containerPort|hostPort/);
  });
});
