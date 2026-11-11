<?php

declare(strict_types=1);

namespace Sureneco\FcmTrial;

final class SafeFailure extends \RuntimeException
{
    public function __construct(
        public readonly string $reason,
        public readonly ?int $httpStatus = null,
        public readonly ?string $providerError = null,
    ) {
        parent::__construct($reason);
    }

    public function result(?string $operation): array
    {
        $result = ['ok' => false, 'operation' => $operation, 'status' => 'error', 'error' => $this->reason];
        if ($this->httpStatus !== null) {
            $result['httpStatus'] = $this->httpStatus;
        }
        if ($this->providerError !== null) {
            $result['providerError'] = $this->providerError;
        }
        return $result;
    }
}
