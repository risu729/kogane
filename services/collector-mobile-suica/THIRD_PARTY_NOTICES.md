# Third-party implementation references

The Mobile Suica history pagination and eight-column row interpretation were
informed by `pnsk-lab/mnie`'s MIT-licensed `provider-mobile-suica` implementation
at commit `c87e65c0a04c03c560962f8ead6e77415fb841f4`.

The implementation in this directory is isolated for Kogane, preserves raw
responses before normalization, does not include `mnie`'s legacy login flow,
and does not serialize a username or password into the replay envelope.
