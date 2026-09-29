import React from 'react';
import { render, screen } from '@testing-library/react';
import { DiligenceSnapshot } from './DiligenceSnapshot';
import { DeploymentContext } from '../context/DeploymentContext';

const mockDeploymentRecord = {
  registryAddress: '0x1234567890123456789012345678901234567890',
  escrowAddress: '0x0987654321098765432109876543210987654321',
  networkId: '1',
  bytecodeHashes: {
    'ContractA': '0xabcdef1234567890abcdef1234567890abcdef12',
    'ContractB': '0x1234567890abcdef1234567890abcdef12345678'
  }
};

const mockSelfCheckRecord = {
  registryAddress: '0x1234567890123456789012345678901234567890',
  escrowAddress: '0x0987654321098765432109876543210987654321',
  networkId: '1',
  bytecodeHashes: {
    'ContractA': '0xabcdef1234567890abcdef1234567890abcdef12',
    'ContractB': '0x1234567890abcdef1234567890abcdef12345678'
  }
};

const mockMismatchedSelfCheckRecord = {
  registryAddress: '0x1111111111111111111111111111111111111111',
  escrowAddress: '0x0987654321098765432109876543210987654321',
  networkId: '1',
  bytecodeHashes: {
    'ContractA': '0xabcdef1234567890abcdef1234567890abcdef12',
    'ContractB': '0x1234567890abcdef1234567890abcdef12345678'
  }
};

const mockBytecodeMismatchRecord = {
  registryAddress: '0x1234567890123456789012345678901234567890',
  escrowAddress: '0x0987654321098765432109876543210987654321',
  networkId: '1',
  bytecodeHashes: {
    'ContractA': '0xabcdef1234567890abcdef1234567890abcdef12',
    'ContractB': '0x9999999999999999999999999999999999999999'
  }
};

describe('DiligenceSnapshot', () => {
  const renderWithContext = (selfCheckRecord: any, deploymentRecord?: any) => {
    return render(
      <DeploymentContext.Provider value={{ deploymentRecord: deploymentRecord || mockDeploymentRecord }}>
        <DiligenceSnapshot selfCheckRecord={selfCheckRecord} />
      </DeploymentContext.Provider>
    );
  };

  it('renders snapshot with matching deployment record', () => {
    renderWithContext(mockSelfCheckRecord);

    expect(screen.getByTestId('dil-snapshot-visible')).toBeInTheDocument();
    expect(screen.getByText('Diligence Snapshot')).toBeInTheDocument();
    expect(screen.getByText(mockDeploymentRecord.registryAddress)).toBeInTheDocument();
    expect(screen.getByText(mockDeploymentRecord.escrowAddress)).toBeInTheDocument();
    expect(screen.getByText(/ContractA: 0xabcdef...cdef12/i)).toBeInTheDocument();
  });

  it('hides snapshot when registry address differs', () => {
    renderWithContext(mockMismatchedSelfCheckRecord);

    expect(screen.getByTestId('dil-snapshot-hidden')).toBeInTheDocument();
    expect(screen.getByText(/Snapshot hidden due to mismatched deployment record/i)).toBeInTheDocument();
    expect(screen.getByText(/registry: expected 0x1111111111111111111111111111111111111111, got 0x1234567890123456789012345678901234567890/i)).toBeInTheDocument();
  });

  it('hides snapshot when bytecode hashes differ', () => {
    renderWithContext(mockBytecodeMismatchRecord);

    expect(screen.getByTestId('dil-snapshot-hidden')).toBeInTheDocument();
    expect(screen.getByText(/bytecode hashes do not match/i)).toBeInTheDocument();
  });

  it('does not expose secrets in visible text', () => {
    renderWithContext(mockSelfCheckRecord);

    const visibleText = screen.getByTestId('dil-snapshot-visible').textContent;
    expect(visibleText).not.toContain('secret');
    expect(visibleText).not.toContain('private');
    expect(visibleText).not.toContain('deployer');
  });

  it('shows network name from config when available', () => {
    renderWithContext(mockSelfCheckRecord);

    expect(screen.getByText('Ethereum Mainnet')).toBeInTheDocument();
  });
});
