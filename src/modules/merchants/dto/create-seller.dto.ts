import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateSellerDto {
  @IsString() @MaxLength(120) businessName!: string;
  @IsOptional() @IsEmail() email?: string;
}
