# OVHcloud Public Cloud provider boundary

Contract assumptions verified on 2026-08-23 against OVHcloud's official [OpenStack API guide](https://help.ovhcloud.com/csm/en-ie-public-cloud-compute-starting-nova-api?id=kb_article_view&sysparm_article=KB0051253) and [security group guide](https://help.ovhcloud.com/csm/en-sg-public-cloud-compute-firewall-security?id=kb_article_view&sysparm_article=KB0051164).

- Compute lifecycle, images and snapshots use standard OpenStack services exposed by OVHcloud.
- Firewall replacement represents Neutron security-group rules attached to instance networking ports.
- Gridora metadata keys are applied to each server and are queried before a timed-out create is retried.
- The concrete authenticated OpenStack HTTP client is an adapter supplied at the application edge; package tests use only deterministic fakes.

Endpoint/catalog versions are discovered from Keystone rather than pinned in this domain adapter.
