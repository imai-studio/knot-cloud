import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";

export function MagicLinkEmail({ url }: { url: string }) {
  return (
    <Html lang="en">
      <Head />
      <Preview>Your secure sign-in link for Knot</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.mark}>K</Section>
          <Heading style={styles.heading}>Sign in to Knot</Heading>
          <Text style={styles.text}>
            Use this secure link to open your Knot dashboard. It expires in 10
            minutes and can only be used once.
          </Text>
          <Button href={url} style={styles.button}>
            Open Knot
          </Button>
          <Hr style={styles.rule} />
          <Text style={styles.muted}>
            If you did not request this email, you can safely ignore it.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const styles = {
  body: {
    backgroundColor: "#f4f0f5",
    color: "#332c40",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    margin: "0",
    padding: "32px 12px",
  },
  container: {
    backgroundColor: "#fffdfa",
    border: "1px solid #e3dae6",
    borderRadius: "16px",
    margin: "0 auto",
    maxWidth: "500px",
    padding: "36px",
  },
  mark: {
    backgroundColor: "#7654a3",
    borderRadius: "10px",
    color: "#fffdfa",
    fontSize: "16px",
    fontWeight: "700",
    height: "32px",
    lineHeight: "32px",
    textAlign: "center" as const,
    width: "32px",
  },
  heading: {
    fontSize: "28px",
    lineHeight: "1.15",
    margin: "28px 0 12px",
  },
  text: {
    color: "#70677a",
    fontSize: "16px",
    lineHeight: "1.6",
    margin: "0 0 24px",
  },
  button: {
    backgroundColor: "#7654a3",
    borderRadius: "8px",
    color: "#ffffff",
    display: "inline-block",
    fontSize: "15px",
    fontWeight: "600",
    padding: "12px 20px",
    textDecoration: "none",
  },
  rule: {
    borderColor: "#e3dae6",
    margin: "32px 0 18px",
  },
  muted: {
    color: "#70677a",
    fontSize: "13px",
    lineHeight: "1.5",
    margin: "0",
  },
};
