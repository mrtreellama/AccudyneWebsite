<?php
// Minimal mail handler for the contact form, for hosting that runs PHP (e.g. BlueHost).
// Point the form at it by building with PUBLIC_FORM_ENDPOINT=/contact.php.
// It has no dependencies and touches no database.

$to = 'info@accudyne.com';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false]);
    exit;
}

// Honeypot: real visitors never fill this in.
if (!empty($_POST['website'])) {
    echo json_encode(['ok' => true]);
    exit;
}

$clean = fn($v) => trim(str_replace(["\r", "\n"], ' ', (string)($v ?? '')));
$name = $clean($_POST['name'] ?? '');
$email = filter_var($clean($_POST['email'] ?? ''), FILTER_VALIDATE_EMAIL);
$subject = $clean($_POST['subject'] ?? '');
$message = trim((string)($_POST['message'] ?? ''));

if ($name === '' || !$email || $subject === '' || $message === '' || strlen($message) > 10000) {
    http_response_code(422);
    echo json_encode(['ok' => false]);
    exit;
}

$body = "Name: $name\nE-mail: $email\n\n$message\n";
$headers = "From: Accudyne website <no-reply@{$_SERVER['SERVER_NAME']}>\r\nReply-To: $email\r\n";

$sent = mail($to, "Website enquiry: $subject", $body, $headers);
http_response_code($sent ? 200 : 500);
echo json_encode(['ok' => $sent]);
